import type { Redis } from 'ioredis'

import { logger } from '../../logger.ts'
import type { createSandboxActivityService } from '../activities/index.ts'
import { HttpError } from '../http-error.ts'
import type { createPlacementService } from '../placement/index.ts'
import type { createWorkspaceService } from '../workspaces/index.ts'
import { depsCache } from './deps-cache.ts'
import { createRedisLog } from './log.ts'
import { type NetworkRules, PROXY_PORT } from './network-controller.ts'
import { portPool } from './port-pool.ts'
import { createSandbox } from './sandbox.ts'

const log = logger('sandbox-manager')

const READY_TIMEOUT_MS = 90 * 1000

export const launchLogKey = (workspaceId: string) => `launch-logs:${workspaceId}`

export type LaunchOptions = { command: string; port: number; env: Record<string, string>; network: NetworkRules }

export type ExecOptions = { command: string; timeoutMs: number; env: Record<string, string> }

export const createSandboxManager = ({
  workspaces,
  activities,
  placement,
  redis,
  mode,
  memoryMaxMb,
  cpuMax,
  pidsMax,
  portMin,
  portMax,
  idleMs,
  depsRoot,
}: {
  workspaces: ReturnType<typeof createWorkspaceService>
  activities: ReturnType<typeof createSandboxActivityService>
  placement: ReturnType<typeof createPlacementService>
  redis: Redis
  mode: 'bwrap' | 'none'
  memoryMaxMb: number
  cpuMax: number
  pidsMax: number
  portMin: number
  portMax: number
  idleMs: number
  depsRoot: string
}) => {
  const sandboxes = new Map<string, ReturnType<typeof createSandbox>>()
  const ports = portPool(portMin, portMax)
  const deps = depsCache(depsRoot)
  const locks = new Map<string, Promise<unknown>>()

  const locked = async <T>(workspaceId: string, fn: () => Promise<T>) => {
    const previous = locks.get(workspaceId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(fn)
    locks.set(workspaceId, current)

    try {
      return await current
    } finally {
      if (locks.get(workspaceId) === current) locks.delete(workspaceId)
    }
  }

  const getDefaultEnv = async (workspaceId: string, port: number | null) => ({
    ...(port === null ? {} : { PORT: String(port) }),
    ...(await workspaces.getDefaultEnv(workspaceId)),
  })

  const settle = async (
    workspaceId: string,
    kind: 'launch' | 'exec',
    command: string,
    sandbox: ReturnType<typeof createSandbox>,
    status: 'succeeded' | 'failed',
    exitCode: number | null
  ) => {
    const output = (await sandbox.logs(5000)).join('\n').slice(-16 * 1024)
    await activities.record(workspaceId, kind, command, { status, exitCode, output })
    return output
  }

  const start = async (workspaceId: string, { command, port, env, network }: LaunchOptions) => {
    const dir = workspaces.getWorkspaceRoot(workspaceId)
    const { mounts, env: depsEnv } = await deps.mounts(workspaceId, dir)
    await placement.claimWorkspace(workspaceId)

    const hostPort = ports.take()
    if (hostPort === null) {
      log.warn({ workspaceId }, 'workspace app not launched: no free port on this worker')
      await placement.releaseWorkspace(workspaceId)
      await activities.record(workspaceId, 'launch', command, {
        status: 'failed',
        exitCode: null,
        output: 'No free port on this worker',
      })
      return null
    }

    await sandboxes.get(workspaceId)?.deleteLogs()
    const launched = createSandbox(workspaceId, {
      dir,
      mounts,
      mode,
      memoryMaxMb,
      cpuMax,
      pidsMax,
      command,
      env: { ...depsEnv, ...env },
      network,
      ports: { inside: port, host: hostPort },
      readyTimeoutMs: READY_TIMEOUT_MS,
      log: createRedisLog(redis, launchLogKey(workspaceId)),
    })
    sandboxes.set(workspaceId, launched)
    log.info({ workspaceId, port: hostPort }, 'workspace app launching')

    void launched.ready().then(
      async () => {
        log.info({ workspaceId, port: hostPort }, 'workspace app running')
        await workspaces.setStatus(workspaceId, 'running')
        await settle(workspaceId, 'launch', command, launched, 'succeeded', null)
      },
      async () => {
        log.warn({ workspaceId }, 'workspace app failed to start')
        await settle(workspaceId, 'launch', command, launched, 'failed', await launched.exited())
      }
    )
    // every way a sandbox ends, stop, sweep, shutdown or on its own, comes through here
    void launched.exited().then(async exitCode => {
      ports.release(hostPort)
      await launched.deleteLogs()
      if (sandboxes.has(workspaceId) && sandboxes.get(workspaceId) !== launched) return

      await placement.releaseWorkspace(workspaceId)
      if (launched.status() === 'failed') {
        log.warn({ workspaceId, exitCode }, 'workspace app exited on its own')
        await workspaces.setStatus(workspaceId, 'stopped')
      }
    })

    return launched
  }

  return {
    launch: (workspaceId: string, { command, port, env, network }: LaunchOptions) =>
      locked(workspaceId, async () => {
        if (port === PROXY_PORT) throw new HttpError(400, `Port ${PROXY_PORT} is held by the sandbox's proxy`)

        const options = { command, port, network, env: { ...(await getDefaultEnv(workspaceId, port)), ...env } }

        const status = sandboxes.get(workspaceId)?.status()
        if (status === 'starting' || status === 'running')
          throw new HttpError(409, 'A background process is already running')
        if (!(await start(workspaceId, options))) throw new HttpError(503, 'No free port on this worker')

        await workspaces.setLaunchOptions(workspaceId, options)
      }),

    exec: async (workspaceId: string, { command, timeoutMs, env }: ExecOptions) => {
      const launched = sandboxes.get(workspaceId)
      const status = launched?.status()
      const server = status === 'starting' || status === 'running' ? launched : undefined

      const dir = workspaces.getWorkspaceRoot(workspaceId)
      const { mounts, env: depsEnv } = await deps.mounts(workspaceId, dir)
      const childEnv = { ...depsEnv, ...(await getDefaultEnv(workspaceId, server?.port ?? null)), ...env }

      const child = createSandbox(workspaceId, {
        dir,
        mounts,
        mode,
        memoryMaxMb,
        cpuMax,
        pidsMax,
        command,
        env: childEnv,
        joinPid: server?.pid,
      })

      const release = server?.use()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        void child.kill()
      }, timeoutMs)

      try {
        const exited = await child.exited()
        clearTimeout(timer)
        const exitCode = timedOut ? null : exited
        const output = await settle(
          workspaceId,
          'exec',
          command,
          child,
          exitCode === 0 ? 'succeeded' : 'failed',
          exitCode
        )
        log.info({ workspaceId, exitCode, timedOut }, 'workspace command finished')

        return { exitCode, output, timedOut }
      } finally {
        release?.()
        await child.deleteLogs()
      }
    },

    stop: (workspaceId: string) =>
      locked(workspaceId, async () => {
        await workspaces.setLaunchOptions(workspaceId, null)
        await sandboxes.get(workspaceId)?.kill()
        sandboxes.delete(workspaceId)
        await workspaces.setStatus(workspaceId, 'stopped')
        log.info({ workspaceId }, 'workspace app stopped')
      }),

    count: () => sandboxes.size,

    hostPort: (workspaceId: string) =>
      sandboxes.get(workspaceId)?.status() === 'running' ? sandboxes.get(workspaceId)!.hostPort : null,

    wake: async (workspaceId: string) => {
      const launched = await locked(workspaceId, async () => {
        const current = sandboxes.get(workspaceId)
        if (current && current.status() !== 'stopped') return current

        const options = await workspaces.getLaunchOptions(workspaceId)
        return options ? start(workspaceId, options) : null
      })
      if (!launched) return null

      if (launched.status() === 'starting') await launched.ready().catch(() => {})

      return launched
    },

    stopIdle: async () => {
      await Promise.all(
        [...sandboxes]
          .filter(
            ([, launched]) =>
              (launched.status() === 'running' || launched.status() === 'failed') && launched.isIdle(idleMs)
          )
          .map(async ([workspaceId, launched]) => {
            if (launched.status() === 'running') {
              log.info({ workspaceId }, 'stopping idle workspace app')
              await launched.kill()
              await launched.deleteLogs()
            }
            if (sandboxes.get(workspaceId) !== launched) return
            sandboxes.delete(workspaceId)
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
            if (sandboxes.get(workspaceId) !== launched) return
            sandboxes.delete(workspaceId)
            await workspaces.setStatus(workspaceId, 'stopped')
          })
      )
    },
  }
}
