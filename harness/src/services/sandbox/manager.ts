import { join } from 'node:path'

import type { Redis } from 'ioredis'

import { logger } from '../../logger.ts'
import type { createSandboxActivityService } from '../activities/index.ts'
import { HttpError } from '../http-error.ts'
import type { createPlacementService } from '../placement/index.ts'
import type { createWorkspaceService } from '../workspaces/index.ts'
import { depsCache } from './deps-cache.ts'
import { createRedisLog } from './log.ts'
import { DNS_PORT } from './network-controller.ts'
import { portPool } from './port-pool.ts'
import { SANDBOXES_CGROUP, type Sandbox, createSandbox } from './sandbox.ts'

const log = logger('sandbox-manager')

const READY_TIMEOUT_MS = 90 * 1000
const MISSING_DEPS_HINT = 'If deps are missing, put the install step in the launch command, e.g. "npm ci && npm start".'

const isLive = (sandbox: Sandbox | undefined) => sandbox?.status() === 'starting' || sandbox?.status() === 'running'

export const launchLogKey = (workspaceId: string) => `launch-log:${workspaceId}`

export type LaunchOptions = { command: string; port: number; env: Record<string, string> }

export type ExecOptions = { command: string; timeoutMs: number; env: Record<string, string> }

export type SandboxEvent = 'launch' | 'stop' | 'idle-stop' | 'exec-start' | 'exec-end'

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
  const sandboxes = new Map<string, Sandbox>()
  const ports = portPool(portMin, portMax)
  const deps = depsCache(depsRoot)
  const locks = new Map<string, Promise<unknown>>()
  const listeners: ((event: SandboxEvent) => void)[] = []
  const changed = (event: SandboxEvent) => listeners.forEach(listener => listener(event))

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
    sandbox: Sandbox,
    status: 'succeeded' | 'failed',
    exitCode: number | null
  ) => {
    const output = (await sandbox.logs(5000)).join('\n').slice(-16 * 1024)
    await activities.record(workspaceId, kind, command, { status, exitCode, output })
    return output
  }

  const start = async (workspaceId: string, { command, port, env }: LaunchOptions) => {
    const dir = workspaces.getWorkspaceRoot(workspaceId)
    const { mounts, env: depsEnv } = await deps.mounts(workspaceId, dir)
    const network = await workspaces.getNetwork(workspaceId)
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

    const launchLog = createRedisLog(redis, launchLogKey(workspaceId))
    const launched = await createSandbox(join(SANDBOXES_CGROUP, `workspace-${workspaceId}`), {
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
      log: launchLog,
    }).catch(async error => {
      ports.release(hostPort)
      await placement.releaseWorkspace(workspaceId)
      throw error
    })
    sandboxes.set(workspaceId, launched)
    changed('launch')
    await workspaces.setStatus(workspaceId, 'starting')
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
    void launched.exited().then(async exitCode => {
      if (launched.status() === 'failed') launchLog.write(`${MISSING_DEPS_HINT}\n`)
      // for now every way a sandbox ends, stop, sweep, shutdown or a crash, is dropped here, as a crash has no caller to do it
      await locked(workspaceId, () => drop(workspaceId, launched, exitCode))
    })

    return launched
  }

  const drop = async (workspaceId: string, launched: Sandbox, exitCode: number | null) => {
    ports.release(launched.hostPort!)
    await launched.deleteLogs()
    if (sandboxes.has(workspaceId) && sandboxes.get(workspaceId) !== launched) return

    await placement.releaseWorkspace(workspaceId)
    if (launched.status() === 'failed') {
      log.warn({ workspaceId, exitCode }, 'workspace app exited on its own')
      await workspaces.setStatus(workspaceId, 'stopped')
    }
  }

  return {
    launch: async (workspaceId: string, { command, port, env }: LaunchOptions) => {
      if (port === DNS_PORT) throw new HttpError(400, `Port ${DNS_PORT} is held by the sandbox's DNS`)

      const options = { command, port, env: { ...(await getDefaultEnv(workspaceId, port)), ...env } }

      const launched = await locked(workspaceId, async () => {
        if (isLive(sandboxes.get(workspaceId))) throw new HttpError(409, 'A background process is already running')

        return start(workspaceId, options)
      })
      if (!launched) throw new HttpError(503, 'No free port on this worker')

      await launched.ready().catch(() => {})
      if (launched.status() !== 'running')
        throw new HttpError(502, `The app didn't start:\n${(await launched.logs(20, true)).join('\n')}`)

      await workspaces.setLaunchOptions(workspaceId, options)
    },

    exec: async (workspaceId: string, { command, timeoutMs, env }: ExecOptions) => {
      const launched = sandboxes.get(workspaceId)
      const server = isLive(launched) ? launched : undefined

      const dir = workspaces.getWorkspaceRoot(workspaceId)
      const { mounts, env: depsEnv } = await deps.mounts(workspaceId, dir)

      const child = await createSandbox(join(SANDBOXES_CGROUP, `workspace-${workspaceId}`), {
        dir,
        mounts,
        mode,
        memoryMaxMb,
        cpuMax,
        pidsMax,
        command,
        env: { ...depsEnv, ...(await getDefaultEnv(workspaceId, server?.port ?? null)), ...env },
        network: await workspaces.getNetwork(workspaceId),
        joinPid: server?.pid,
      })

      changed('exec-start')
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
        changed('exec-end')
      }
    },

    stop: (workspaceId: string) =>
      locked(workspaceId, async () => {
        await sandboxes.get(workspaceId)?.kill()
        sandboxes.delete(workspaceId)
        changed('stop')
        await workspaces.setStatus(workspaceId, 'stopped')
        log.info({ workspaceId }, 'workspace app stopped')
      }),

    count: () => sandboxes.size,

    onChange: (listener: (event: SandboxEvent) => void) => void listeners.push(listener),

    hostPort: (workspaceId: string) => {
      const launched = sandboxes.get(workspaceId)
      return launched?.status() === 'running' ? launched.hostPort : null
    },

    wake: async (workspaceId: string) => {
      const launched = await locked(workspaceId, async () => {
        const current = sandboxes.get(workspaceId)
        if (current && current.status() !== 'stopped') return current

        const options = await workspaces.getLaunchOptions(workspaceId)
        return options ? start(workspaceId, options) : null
      })

      await launched?.ready().catch(() => {})
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
            if (launched.status() === 'running') log.info({ workspaceId }, 'stopping idle workspace app')
            await launched.kill()
            if (sandboxes.get(workspaceId) !== launched) return
            sandboxes.delete(workspaceId)
            changed('idle-stop')
            await workspaces.setStatus(workspaceId, 'stopped')
          })
      )
    },

    stopAll: async () => {
      await Promise.all(
        [...sandboxes]
          .filter(([, launched]) => isLive(launched))
          .map(async ([workspaceId, launched]) => {
            await launched.kill()
            if (sandboxes.get(workspaceId) !== launched) return
            sandboxes.delete(workspaceId)
            changed('stop')
            await workspaces.setStatus(workspaceId, 'stopped')
          })
      )
    },
  }
}
