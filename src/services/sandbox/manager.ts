import { HttpError } from '../http-error.ts'
import type { createWorkspaceService } from '../workspaces/index.ts'
import type { NetworkRules } from './network-controller.ts'
import { portPool } from './port-pool.ts'
import { createSandbox } from './sandbox.ts'

const READY_TIMEOUT_MS = 90 * 1000

export type LaunchOptions = { command: string; port: number; env: Record<string, string>; network: NetworkRules }

export type ExecOptions = { command: string; timeoutMs: number; env: Record<string, string> }

export const createSandboxManager = ({
  workspaces,
  mode,
  memoryMaxMb,
  cpuMax,
  pidsMax,
  portMin,
  portMax,
  idleMs,
}: {
  workspaces: ReturnType<typeof createWorkspaceService>
  mode: 'bwrap' | 'none'
  memoryMaxMb: number
  cpuMax: number
  pidsMax: number
  portMin: number
  portMax: number
  idleMs: number
}) => {
  const sandboxes = new Map<string, ReturnType<typeof createSandbox>>()
  const ports = portPool(portMin, portMax)

  const getDefaultEnv = async (workspaceId: string, port: number | null) => ({
    ...(port === null ? {} : { PORT: String(port) }),
    ...(await workspaces.getDefaultEnv(workspaceId)),
  })

  const start = (workspaceId: string, { command, port, env, network }: LaunchOptions) => {
    const hostPort = ports.take()
    if (hostPort === null) return null

    const launched = createSandbox(workspaceId, {
      dir: workspaces.getWorkspaceRoot(workspaceId),
      mode,
      memoryMaxMb,
      cpuMax,
      pidsMax,
      command,
      env,
      network,
      ports: { inside: port, host: hostPort },
      readyTimeoutMs: READY_TIMEOUT_MS,
    })
    void sandboxes.get(workspaceId)?.deleteLogs()
    sandboxes.set(workspaceId, launched)

    void launched.ready().then(
      () => workspaces.setStatus(workspaceId, 'running'),
      () => {}
    )
    void launched.exited().then(async () => {
      ports.release(hostPort)
      if (launched.status() === 'failed') await workspaces.setStatus(workspaceId, 'stopped')
    })

    return launched
  }

  return {
    launch: async (workspaceId: string, { command, port, env, network }: LaunchOptions) => {
      const options = { command, port, network, env: { ...(await getDefaultEnv(workspaceId, port)), ...env } }

      const status = sandboxes.get(workspaceId)?.status()
      if (status === 'starting' || status === 'running') throw new HttpError(409, 'A background process is already running')
      if (!start(workspaceId, options)) throw new HttpError(503, 'No free port on this worker')

      await workspaces.setLaunchOptions(workspaceId, options)
    },

    exec: async (workspaceId: string, { command, timeoutMs, env }: ExecOptions) => {
      const launched = sandboxes.get(workspaceId)
      const status = launched?.status()
      const server = status === 'starting' || status === 'running' ? launched : undefined

      const child = createSandbox(workspaceId, {
        dir: workspaces.getWorkspaceRoot(workspaceId),
        mode,
        memoryMaxMb,
        cpuMax,
        pidsMax,
        command,
        env: { ...(await getDefaultEnv(workspaceId, server?.port ?? null)), ...env },
        joinPid: server?.pid,
      })

      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        void child.kill()
      }, timeoutMs)

      try {
        const exitCode = await child.exited()
        clearTimeout(timer)
        const output = (await child.logs(5000)).join('\n').slice(-16 * 1024)

        return { exitCode: timedOut ? null : exitCode, output, timedOut }
      } finally {
        await child.deleteLogs()
      }
    },

    stop: async (workspaceId: string) => {
      await workspaces.setLaunchOptions(workspaceId, null)
      await sandboxes.get(workspaceId)?.kill()
      await workspaces.setStatus(workspaceId, 'stopped')
    },

    logs: async (workspaceId: string, tail: number) => (await sandboxes.get(workspaceId)?.logs(tail, true)) ?? [],

    wake: async (workspaceId: string) => {
      let launched = sandboxes.get(workspaceId)

      if (!launched || launched.status() === 'stopped') {
        const options = await workspaces.getLaunchOptions(workspaceId)
        if (!options) return null

        launched = sandboxes.get(workspaceId)
        if (!launched || launched.status() === 'stopped') {
          const started = start(workspaceId, options)
          if (!started) return null
          launched = started
        }
      }

      if (launched.status() === 'starting') await launched.ready().catch(() => {})

      return launched
    },

    stopIdle: async () => {
      await Promise.all(
        [...sandboxes]
          .filter(([, launched]) => launched.status() === 'running' && launched.isIdle(idleMs))
          .map(async ([workspaceId, launched]) => {
            await launched.kill()
            await launched.deleteLogs()
            await workspaces.setStatus(workspaceId, 'stopped')
          })
      )
    },

    stopAll: async () => {
      await Promise.all(
        [...sandboxes]
          .filter(([, launched]) => launched.status() === 'starting' || launched.status() === 'running')
          .map(async ([workspaceId, launched]) => {
            await launched.kill()
            await launched.deleteLogs()
            await workspaces.setStatus(workspaceId, 'stopped')
          })
      )
    },
  }
}
