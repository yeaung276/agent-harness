import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { HttpError } from '../../../src/services/http-error.ts'
import type { SandboxOptions, SandboxStatus } from '../../../src/services/sandbox/sandbox.ts'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

let calls: string[] = []
let nextPid = 100

const fakeSandbox = (workspaceId: string, options: SandboxOptions) => {
  const listening = deferred<void>()
  const exit = deferred<number | null>()
  let status: SandboxStatus = 'starting'

  const fake = {
    workspaceId,
    options,
    pid: nextPid++,
    port: options.ports?.inside ?? null,
    hostPort: options.ports?.host ?? null,
    lines: [] as string[],
    unreadable: false,
    logsDeleted: false,
    idle: false,
    kills: 0,
    idleChecks: [] as number[],

    status: () => status,
    ready: () => listening.promise,
    exited: () => exit.promise,
    logs: async (tail: number, clean = false) => {
      if (fake.unreadable) throw new Error('log unreadable')
      if (fake.logsDeleted) return []
      return fake.lines.filter(line => !clean || line.trim()).slice(-tail)
    },
    deleteLogs: async () => {
      fake.logsDeleted = true
    },
    kill: async () => {
      fake.kills++
      calls.push(`kill ${workspaceId}`)
      if (status !== 'starting' && status !== 'running') return
      status = 'stopped'
      listening.reject(new Error('killed'))
      exit.resolve(143)
    },
    use: () => () => {},
    isIdle: (idleMs: number) => {
      fake.idleChecks.push(idleMs)
      return fake.idle
    },

    listen: () => {
      status = 'running'
      listening.resolve()
    },
    crash: () => {
      status = 'failed'
      listening.reject(new Error('exited'))
      exit.resolve(1)
    },
    finish: (exitCode: number) => {
      status = 'stopped'
      exit.resolve(exitCode)
    },
  }

  return fake
}

const fakes: ReturnType<typeof fakeSandbox>[] = []

mock.module('../../../src/services/sandbox/sandbox.ts', () => ({
  createSandbox: (workspaceId: string, options: SandboxOptions) => {
    const fake = fakeSandbox(workspaceId, options)
    fakes.push(fake)
    return fake
  },
}))

const { createSandboxManager } = await import('../../../src/services/sandbox/manager.ts')

type LaunchOptions = Parameters<ReturnType<typeof createSandboxManager>['launch']>[1]

const lag = () => Bun.sleep(Math.random() * 3)

const fakeWorkspaces = () => {
  const known = new Set(['ws-1', 'ws-2', 'ws-3'])
  const defaultEnvs = new Map<string, Record<string, string>>()
  const statuses = new Map<string, 'running' | 'stopped'>()
  const saved = new Map<string, LaunchOptions | null>()

  return {
    defaultEnvs,
    statuses,
    saved,
    getWorkspaceRoot: (id: string) => `/workspaces/${id}`,
    getDefaultEnv: async (id: string) => {
      await lag()
      if (!known.has(id)) throw new HttpError(404, 'Workspace not found')
      return { ...defaultEnvs.get(id) }
    },
    setStatus: async (id: string, status: 'running' | 'stopped') => {
      await lag()
      calls.push(`status ${id} ${status}`)
      statuses.set(id, status)
    },
    setLaunchOptions: async (id: string, options: LaunchOptions | null) => {
      await lag()
      calls.push(`options ${id} ${options ? 'saved' : 'cleared'}`)
      saved.set(id, options)
    },
    getLaunchOptions: async (id: string) => {
      await lag()
      calls.push(`read ${id}`)
      return saved.get(id) ?? null
    },
  }
}

const devServer: LaunchOptions = { command: 'npm run dev', port: 3000, env: {}, network: {} }

let workspaces: ReturnType<typeof fakeWorkspaces>
let manager: ReturnType<typeof createSandboxManager>

const launchesOf = (id: string) => fakes.filter(fake => fake.workspaceId === id && fake.options.ports)
const execsOf = (id: string) => fakes.filter(fake => fake.workspaceId === id && !fake.options.ports)
const latestLaunch = (id: string) => launchesOf(id).at(-1)!

const until = async (check: () => boolean, what: string) => {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

const bringUp = async (id: string, options = devServer) => {
  await manager.launch(id, options)
  const launched = latestLaunch(id)
  launched.listen()
  await until(() => workspaces.statuses.get(id) === 'running', `${id} running`)
  return launched
}

const startExec = async (id: string, command = 'ls', timeoutMs = 1000) => {
  const pending = manager.exec(id, { command, timeoutMs, env: {} })
  await until(() => execsOf(id).length === 1, 'exec')
  return { pending, child: execsOf(id)[0]! }
}

beforeEach(() => {
  fakes.length = 0
  calls = []
  workspaces = fakeWorkspaces()
  manager = createSandboxManager({
    workspaces: workspaces as unknown as Parameters<typeof createSandboxManager>[0]['workspaces'],
    mode: 'none',
    memoryMaxMb: 512,
    cpuMax: 1,
    pidsMax: 64,
    portMin: 4100,
    portMax: 4101,
    idleMs: 60_000,
  })
})

describe('launch', () => {
  test('starts the command in its workspace with its port mapped to a pool port, and answers before it listens', async () => {
    await manager.launch('ws-1', devServer)

    expect(launchesOf('ws-1')).toHaveLength(1)
    expect(latestLaunch('ws-1').options).toMatchObject({
      dir: '/workspaces/ws-1',
      command: 'npm run dev',
      ports: { inside: 3000, host: 4100 },
    })
    expect(latestLaunch('ws-1').status()).toBe('starting')
    expect(workspaces.statuses.get('ws-1')).toBeUndefined()
  })

  test('gives the command 90 s to start listening', async () => {
    await manager.launch('ws-1', devServer)

    expect(latestLaunch('ws-1').options.readyTimeoutMs).toBe(90_000)
  })

  test('records the workspace running once the command listens', async () => {
    await manager.launch('ws-1', devServer)

    latestLaunch('ws-1').listen()

    await until(() => workspaces.statuses.get('ws-1') === 'running', 'running')
  })

  test("confines it with the sandbox mode, limits and the launch's network rules", async () => {
    const network = { deny: ['*'], allow: ['registry.npmjs.org'] }

    await manager.launch('ws-1', { ...devServer, network })

    expect(latestLaunch('ws-1').options).toMatchObject({ mode: 'none', memoryMaxMb: 512, cpuMax: 1, pidsMax: 64, network })
  })

  test("sets PORT to the port it listens on, with the workspace's env and then the launch's env on top", async () => {
    workspaces.defaultEnvs.set('ws-1', { NODE_ENV: 'production', API_URL: 'https://a.example' })

    await manager.launch('ws-1', { ...devServer, env: { API_URL: 'https://b.example' } })

    expect(latestLaunch('ws-1').options.env).toEqual({
      PORT: '3000',
      NODE_ENV: 'production',
      API_URL: 'https://b.example',
    })
  })

  test("lets a PORT in the workspace's env or the launch's env win over its own", async () => {
    workspaces.defaultEnvs.set('ws-1', { PORT: '8080' })
    workspaces.defaultEnvs.set('ws-2', { PORT: '8080' })

    await manager.launch('ws-1', devServer)
    await manager.launch('ws-2', { ...devServer, env: { PORT: '9090' } })

    expect(latestLaunch('ws-1').options.env.PORT).toBe('8080')
    expect(latestLaunch('ws-2').options.env.PORT).toBe('9090')
  })

  test('saves the launch with its merged env, so the workspace can wake exactly as launched', async () => {
    workspaces.defaultEnvs.set('ws-1', { NODE_ENV: 'production' })

    await manager.launch('ws-1', { ...devServer, env: { DEBUG: '1' }, network: { deny: ['*'] } })

    expect(workspaces.saved.get('ws-1')).toEqual({
      command: 'npm run dev',
      port: 3000,
      network: { deny: ['*'] },
      env: { PORT: '3000', NODE_ENV: 'production', DEBUG: '1' },
    })
  })

  test('is a 409 while the last launch is starting or running, and starts nothing more', async () => {
    await manager.launch('ws-1', devServer)
    await expect(manager.launch('ws-1', devServer)).rejects.toMatchObject({ status: 409 })

    latestLaunch('ws-1').listen()
    await expect(manager.launch('ws-1', devServer)).rejects.toMatchObject({ status: 409 })

    expect(launchesOf('ws-1')).toHaveLength(1)
  })

  test('lets only one of two racing launches through', async () => {
    const results = await Promise.allSettled([manager.launch('ws-1', devServer), manager.launch('ws-1', devServer)])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    expect(launchesOf('ws-1')).toHaveLength(1)
  })

  test('is a 503 once every pool port is taken, and saves nothing', async () => {
    await manager.launch('ws-1', devServer)
    await manager.launch('ws-2', devServer)

    await expect(manager.launch('ws-3', devServer)).rejects.toMatchObject({ status: 503 })

    expect(launchesOf('ws-3')).toHaveLength(0)
    expect(workspaces.saved.has('ws-3')).toBe(false)
  })

  test('is a 404 for an unknown workspace, before taking a port', async () => {
    await expect(manager.launch('missing', devServer)).rejects.toMatchObject({ status: 404 })

    await manager.launch('ws-1', devServer)

    expect(launchesOf('missing')).toHaveLength(0)
    expect(latestLaunch('ws-1').hostPort).toBe(4100)
  })

  test('launches again over a launch that failed', async () => {
    const first = await bringUp('ws-1')
    first.crash()

    await manager.launch('ws-1', devServer)

    expect(launchesOf('ws-1')).toHaveLength(2)
    expect(latestLaunch('ws-1').status()).toBe('starting')
  })

  test('launches again after a stop, on the port the stop freed', async () => {
    await bringUp('ws-1')
    await manager.launch('ws-2', devServer)
    await manager.stop('ws-1')

    await manager.launch('ws-1', devServer)

    expect(latestLaunch('ws-1').hostPort).toBe(4100)
  })

  test('deletes the logs of the launch it replaces, and no others', async () => {
    const first = await bringUp('ws-1')
    const other = await bringUp('ws-2')
    first.crash()
    await until(() => workspaces.statuses.get('ws-1') === 'stopped', 'stopped')

    await manager.launch('ws-1', devServer)

    expect(first.logsDeleted).toBe(true)
    expect(latestLaunch('ws-1').logsDeleted).toBe(false)
    expect(other.logsDeleted).toBe(false)
  })
})

describe('a launch ending on its own', () => {
  test('records the workspace stopped and frees its port', async () => {
    const launched = await bringUp('ws-1')
    await manager.launch('ws-2', devServer)

    launched.crash()
    await until(() => workspaces.statuses.get('ws-1') === 'stopped', 'stopped')

    await manager.launch('ws-3', devServer)
    expect(latestLaunch('ws-3').hostPort).toBe(4100)
  })

  test('never records running for a command that dies before it listens', async () => {
    await manager.launch('ws-1', devServer)

    latestLaunch('ws-1').crash()
    await until(() => workspaces.statuses.get('ws-1') === 'stopped', 'stopped')

    expect(calls).not.toContain('status ws-1 running')
  })

  test('keeps its saved launch and its logs', async () => {
    const launched = await bringUp('ws-1')
    launched.lines.push('Error: listen EADDRINUSE')

    launched.crash()
    await until(() => workspaces.statuses.get('ws-1') === 'stopped', 'stopped')

    expect(workspaces.saved.get('ws-1')).toMatchObject({ command: 'npm run dev' })
    expect(await manager.logs('ws-1', 10)).toEqual(['Error: listen EADDRINUSE'])
  })
})

describe('exec', () => {
  test("runs the command in its workspace with the workspace's env and its own on top, and returns its result", async () => {
    workspaces.defaultEnvs.set('ws-1', { A: '1', B: '1' })

    const pending = manager.exec('ws-1', { command: 'ls', timeoutMs: 1000, env: { B: '2' } })
    await until(() => execsOf('ws-1').length === 1, 'exec')
    execsOf('ws-1')[0]!.lines.push('package.json', 'src')
    execsOf('ws-1')[0]!.finish(0)

    expect(await pending).toEqual({ exitCode: 0, output: 'package.json\nsrc', timedOut: false })
    expect(execsOf('ws-1')[0]!.options).toMatchObject({ dir: '/workspaces/ws-1', command: 'ls', env: { A: '1', B: '2' } })
  })

  test('answers a failing command with its exit code and output', async () => {
    const { pending, child } = await startExec('ws-1', 'npm test')
    child.lines.push('1 test failed')
    child.finish(2)

    expect(await pending).toEqual({ exitCode: 2, output: '1 test failed', timedOut: false })
  })

  test('returns its output as written, blank lines kept', async () => {
    const { pending, child } = await startExec('ws-1', 'cat package.json')
    child.lines.push('{', '', '}')
    child.finish(0)

    expect((await pending).output).toBe('{\n\n}')
  })

  test('cuts its output to the last 16 KB', async () => {
    const { pending, child } = await startExec('ws-1', 'cat bundle.js')
    child.lines.push('x'.repeat(20_000), 'END')
    child.finish(0)

    const { output } = await pending
    expect(output).toHaveLength(16 * 1024)
    expect(output.endsWith('x\nEND')).toBe(true)
  })

  test('deletes its log once it has been read', async () => {
    const { pending, child } = await startExec('ws-1')
    child.lines.push('package.json')
    child.finish(0)

    expect((await pending).output).toBe('package.json')
    expect(child.logsDeleted).toBe(true)
  })

  test('deletes its log even when reading it fails', async () => {
    const { pending, child } = await startExec('ws-1')
    child.unreadable = true
    child.finish(0)

    await expect(pending).rejects.toThrow('log unreadable')
    expect(child.logsDeleted).toBe(true)
  })

  test('gets its own network, no port and no PORT when nothing is launched', async () => {
    const { pending, child } = await startExec('ws-1')
    child.finish(0)
    await pending

    expect(child.options.joinPid).toBeUndefined()
    expect(child.options.ports).toBeUndefined()
    expect(child.options.network).toBeUndefined()
    expect(child.options.env.PORT).toBeUndefined()
  })

  test("joins a running launch's network and gets its PORT", async () => {
    const launched = await bringUp('ws-1', { ...devServer, port: 5173 })

    const { pending, child } = await startExec('ws-1', 'curl localhost:5173')
    child.finish(0)
    await pending

    expect(child.options.joinPid).toBe(launched.pid)
    expect(child.options.env.PORT).toBe('5173')
  })

  test('joins a launch that is still starting', async () => {
    await manager.launch('ws-1', devServer)

    const { pending, child } = await startExec('ws-1')
    child.finish(0)
    await pending

    expect(child.options.joinPid).toBe(latestLaunch('ws-1').pid)
  })

  test('gets its own network again once the launch has stopped or failed', async () => {
    await bringUp('ws-1')
    await manager.stop('ws-1')
    const failed = await bringUp('ws-2')
    failed.crash()

    for (const id of ['ws-1', 'ws-2']) {
      const { pending, child } = await startExec(id)
      child.finish(0)
      await pending

      expect(child.options.joinPid).toBeUndefined()
      expect(child.options.env.PORT).toBeUndefined()
    }
  })

  test('kills a command still running at timeoutMs, and answers it timed out with no exit code', async () => {
    const { pending, child } = await startExec('ws-1', 'sleep 600', 20)
    child.lines.push('partial output')

    expect(await pending).toEqual({ exitCode: null, output: 'partial output', timedOut: true })
    expect(child.kills).toBe(1)
    expect(child.logsDeleted).toBe(true)
  })

  test("doesn't kill a command that finished in time", async () => {
    const { pending, child } = await startExec('ws-1', 'ls', 30)
    child.finish(0)
    await pending

    await Bun.sleep(60)

    expect(child.kills).toBe(0)
  })

  test("isn't kept: it takes no pool port, adds no logs and doesn't block a launch", async () => {
    const { pending, child } = await startExec('ws-1', 'npm install')
    child.lines.push('added 120 packages')

    expect(await manager.logs('ws-1', 10)).toEqual([])
    await manager.launch('ws-1', devServer)
    expect(latestLaunch('ws-1').hostPort).toBe(4100)

    child.finish(0)
    await pending
  })

  test('runs alongside a running launch without touching it', async () => {
    const launched = await bringUp('ws-1')

    const { pending, child } = await startExec('ws-1')
    child.finish(0)
    await pending

    expect(launched.status()).toBe('running')
    expect(launched.kills).toBe(0)
    expect(launched.logsDeleted).toBe(false)
  })

  test('is a 404 for an unknown workspace, and runs nothing', async () => {
    await expect(manager.exec('missing', { command: 'ls', timeoutMs: 1000, env: {} })).rejects.toMatchObject({
      status: 404,
    })

    expect(execsOf('missing')).toHaveLength(0)
  })
})

describe('stop', () => {
  test('kills the launch, records stopped and frees its port', async () => {
    const launched = await bringUp('ws-1')
    await manager.launch('ws-2', devServer)

    await manager.stop('ws-1')

    expect(launched.kills).toBe(1)
    expect(workspaces.statuses.get('ws-1')).toBe('stopped')
    await manager.launch('ws-3', devServer)
    expect(latestLaunch('ws-3').hostPort).toBe(4100)
  })

  test("clears the saved launch before killing, so a request can't bring it back", async () => {
    await bringUp('ws-1')
    const before = calls.length

    await manager.stop('ws-1')

    expect(calls.slice(before)).toEqual(['options ws-1 cleared', 'kill ws-1', 'status ws-1 stopped'])
    expect(await manager.wake('ws-1')).toBeNull()
    expect(launchesOf('ws-1')).toHaveLength(1)
  })

  test('records stopped and clears the saved launch when nothing runs', async () => {
    await manager.stop('ws-1')

    expect(workspaces.statuses.get('ws-1')).toBe('stopped')
    expect(workspaces.saved.get('ws-1')).toBeNull()
  })

  test('stops a launch that is still starting, and it never records running', async () => {
    await manager.launch('ws-1', devServer)

    await manager.stop('ws-1')
    await Bun.sleep(20)

    expect(latestLaunch('ws-1').status()).toBe('stopped')
    expect(calls).not.toContain('status ws-1 running')
    expect(workspaces.statuses.get('ws-1')).toBe('stopped')
  })

  test('keeps the logs until the next launch', async () => {
    const launched = await bringUp('ws-1')
    launched.lines.push('ready on 3000', 'GET / 200')

    await manager.stop('ws-1')
    expect(await manager.logs('ws-1', 10)).toEqual(['ready on 3000', 'GET / 200'])
    expect(launched.logsDeleted).toBe(false)

    await manager.launch('ws-1', devServer)
    expect(await manager.logs('ws-1', 10)).toEqual([])
    expect(launched.logsDeleted).toBe(true)
  })
})

describe('logs', () => {
  test('are empty before any launch', async () => {
    expect(await manager.logs('ws-1', 10)).toEqual([])
  })

  test("are the last tail lines of the workspace's launch, without blank lines", async () => {
    const launched = await bringUp('ws-1')
    launched.lines.push('one', '', 'two', '  ', 'three')

    expect(await manager.logs('ws-1', 2)).toEqual(['two', 'three'])
    expect(await manager.logs('ws-1', 10)).toEqual(['one', 'two', 'three'])
  })

  test("keep each workspace's lines apart", async () => {
    ;(await bringUp('ws-1')).lines.push('from ws-1')
    ;(await bringUp('ws-2')).lines.push('from ws-2')

    expect(await manager.logs('ws-1', 10)).toEqual(['from ws-1'])
    expect(await manager.logs('ws-2', 10)).toEqual(['from ws-2'])
  })
})

describe('wake', () => {
  test('returns a running launch without reading the saved launch', async () => {
    const launched = await bringUp('ws-1')

    expect(await manager.wake('ws-1')).toBe(launched)
    expect(calls).not.toContain('read ws-1')
  })

  test('holds while the launch starts, until it listens', async () => {
    await manager.launch('ws-1', devServer)

    let answered = false
    const woken = manager.wake('ws-1').finally(() => (answered = true))
    await Bun.sleep(20)
    expect(answered).toBe(false)
    latestLaunch('ws-1').listen()

    expect(await woken).toBe(latestLaunch('ws-1'))
    expect(latestLaunch('ws-1').status()).toBe('running')
  })

  test('stops holding when the launch fails while starting', async () => {
    await manager.launch('ws-1', devServer)

    const woken = manager.wake('ws-1')
    latestLaunch('ws-1').crash()

    expect((await woken)?.status()).toBe('failed')
  })

  test('returns a failed launch as it is, without starting it again', async () => {
    const launched = await bringUp('ws-1')
    launched.crash()

    expect(await manager.wake('ws-1')).toBe(launched)
    expect(launchesOf('ws-1')).toHaveLength(1)
    expect(calls).not.toContain('read ws-1')
  })

  test('starts a swept launch again exactly as launched, holds until it listens, and drops the old logs', async () => {
    workspaces.defaultEnvs.set('ws-1', { NODE_ENV: 'production' })
    const first = await bringUp('ws-1', { command: 'npm start', port: 8080, env: { A: '1' }, network: { deny: ['*'] } })
    first.idle = true
    await manager.stopIdle()

    const woken = manager.wake('ws-1')
    await until(() => launchesOf('ws-1').length === 2, 'relaunch')
    latestLaunch('ws-1').listen()

    expect(await woken).toBe(latestLaunch('ws-1'))
    expect(latestLaunch('ws-1').options).toMatchObject({
      command: 'npm start',
      env: first.options.env,
      network: { deny: ['*'] },
      ports: { inside: 8080 },
      readyTimeoutMs: 90_000,
    })
    expect(first.logsDeleted).toBe(true)
  })

  test('starts a workspace this pod never ran from its saved launch', async () => {
    workspaces.saved.set('ws-1', { command: 'npm start', port: 8080, env: { PORT: '8080' }, network: {} })

    const woken = manager.wake('ws-1')
    await until(() => launchesOf('ws-1').length === 1, 'launch')
    latestLaunch('ws-1').listen()

    expect(await woken).toBe(latestLaunch('ws-1'))
    expect(latestLaunch('ws-1').options).toMatchObject({ command: 'npm start', ports: { inside: 8080, host: 4100 } })
  })

  test('starts one process for two requests racing to wake it', async () => {
    workspaces.saved.set('ws-1', devServer)

    const woken = Promise.all([manager.wake('ws-1'), manager.wake('ws-1')])
    await until(() => launchesOf('ws-1').length === 1, 'launch')
    await Bun.sleep(20)
    latestLaunch('ws-1').listen()

    const [a, b] = await woken
    expect(a).toBe(b)
    expect(launchesOf('ws-1')).toHaveLength(1)
  })

  test('is null with nothing saved, and starts nothing', async () => {
    expect(await manager.wake('ws-1')).toBeNull()
    expect(launchesOf('ws-1')).toHaveLength(0)
  })

  test('is null after a stop', async () => {
    await bringUp('ws-1')
    await manager.stop('ws-1')

    expect(await manager.wake('ws-1')).toBeNull()
    expect(launchesOf('ws-1')).toHaveLength(1)
  })

  test('is null when no pool port is free', async () => {
    workspaces.saved.set('ws-1', devServer)
    await manager.launch('ws-2', devServer)
    await manager.launch('ws-3', devServer)

    expect(await manager.wake('ws-1')).toBeNull()
    expect(launchesOf('ws-1')).toHaveLength(0)
  })
})

describe('stopIdle', () => {
  test('stops running launches idle for the idle time, deletes their logs, records them stopped and keeps their saved launch', async () => {
    const idle = await bringUp('ws-1')
    const busy = await bringUp('ws-2')
    idle.idle = true

    await manager.stopIdle()

    expect(idle.kills).toBe(1)
    expect(idle.logsDeleted).toBe(true)
    expect(workspaces.statuses.get('ws-1')).toBe('stopped')
    expect(workspaces.saved.get('ws-1')).toMatchObject({ command: 'npm run dev' })
    expect(busy.kills).toBe(0)
    expect(busy.logsDeleted).toBe(false)
    expect(workspaces.statuses.get('ws-2')).toBe('running')
  })

  test('asks each running launch whether it has been idle for idleMs', async () => {
    const launched = await bringUp('ws-1')

    await manager.stopIdle()

    expect(launched.idleChecks).toEqual([60_000])
  })

  test('leaves starting launches alone', async () => {
    await manager.launch('ws-1', devServer)
    latestLaunch('ws-1').idle = true

    await manager.stopIdle()

    expect(latestLaunch('ws-1').kills).toBe(0)
    expect(latestLaunch('ws-1').status()).toBe('starting')
  })
})

describe('stopAll', () => {
  test('stops every starting and running launch, deletes their logs, records them stopped and keeps their saved launch', async () => {
    const running = await bringUp('ws-1')
    await manager.launch('ws-2', devServer)
    const starting = latestLaunch('ws-2')

    await manager.stopAll()

    expect([running.kills, starting.kills]).toEqual([1, 1])
    expect([running.logsDeleted, starting.logsDeleted]).toEqual([true, true])
    expect(workspaces.statuses.get('ws-1')).toBe('stopped')
    expect(workspaces.statuses.get('ws-2')).toBe('stopped')
    expect(workspaces.saved.get('ws-1')).toMatchObject({ command: 'npm run dev' })
    expect(workspaces.saved.get('ws-2')).toMatchObject({ command: 'npm run dev' })
  })

  test('leaves launches that already ended alone', async () => {
    const launched = await bringUp('ws-1')
    launched.crash()
    await until(() => workspaces.statuses.get('ws-1') === 'stopped', 'stopped')
    const before = calls.length

    await manager.stopAll()

    expect(calls.slice(before)).toEqual([])
    expect(launched.kills).toBe(0)
  })
})
