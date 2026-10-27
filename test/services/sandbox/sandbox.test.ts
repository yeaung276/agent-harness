import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../../../src/config.ts'
import { depsCache } from '../../../src/services/sandbox/deps-cache.ts'
import {
  assertSandboxUsable,
  createSandbox,
  type SandboxOptions,
  setupCgroups,
} from '../../../src/services/sandbox/sandbox.ts'

const linux = process.env.CONTAINER_TEST === '1'
const mode = linux ? 'bwrap' : 'none'

const SERVER = `bun -e "console.log('listening'); Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') })"`

const config = (env: Record<string, string>) =>
  loadConfig({
    DATABASE_URL: 'postgres://localhost:5432/app',
    REDIS_URL: 'redis://localhost:6379',
    DATA_ENCRYPTION_KEY: '0'.repeat(64),
    ...env,
  })

let root: string
let nextPort = 4300
const sandboxes: ReturnType<typeof createSandbox>[] = []

type Workspace = { id: string; dir: string }

const workspace = async (files: Record<string, string> = {}): Promise<Workspace> => {
  const id = crypto.randomUUID()
  const dir = join(root, id)
  await mkdir(dir)
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content)
  return { id, dir }
}

const start = ({ id, dir }: Workspace, options: Partial<SandboxOptions> & { command: string }) => {
  const sandbox = createSandbox(id, { dir, mounts: [], mode, memoryMaxMb: 256, cpuMax: 1, pidsMax: 128, env: {}, ...options })
  sandboxes.push(sandbox)
  return sandbox
}

const launch = (ws: Workspace, options: Partial<SandboxOptions> = {}) =>
  start(ws, {
    command: SERVER,
    env: { PORT: '3000' },
    ports: { inside: 3000, host: nextPort++ },
    readyTimeoutMs: 30_000,
    ...options,
  })

const run = async (ws: Workspace, command: string, options: Partial<SandboxOptions> = {}) => {
  const sandbox = start(ws, { command, ...options })
  const exitCode = await sandbox.exited()
  return { exitCode, output: (await sandbox.logs(5000)).join('\n') }
}

const get = (host: string, port: number) =>
  fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(2000) }).then(
    response => response.text(),
    () => null
  )

const canBind = (port: number) =>
  new Promise<boolean>(resolve => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })

const until = async (check: () => Promise<boolean>, what: string) => {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(100)
  }
}

const cgroupProcs = async (workspaceId: string) =>
  (await readFile(join('/sys/fs/cgroup', `workspace-${workspaceId}`, 'cgroup.procs'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean).length

beforeAll(async () => {
  await setupCgroups(mode)
  root = await mkdtemp(join(tmpdir(), 'sandbox-test-'))
})

afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) {
    await sandbox.kill()
    await sandbox.deleteLogs()
  }
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('assertSandboxUsable', () => {
  test('lets workspace code run unconfined only outside production', () => {
    expect(() => assertSandboxUsable(config({ SANDBOX_MODE: 'none' }))).not.toThrow()
    expect(() => assertSandboxUsable(config({ SANDBOX_MODE: 'none', NODE_ENV: 'production' }))).toThrow(
      /not allowed with NODE_ENV=production/
    )
  })

  test.skipIf(linux)('refuses bwrap where it cannot confine', () => {
    expect(() => assertSandboxUsable(config({ SANDBOX_MODE: 'bwrap' }))).toThrow(/needs Linux/)
  })

  test.if(linux)('accepts bwrap with its tools, a delegated cgroup tree and the pool outside the ephemeral ports', () => {
    expect(() => assertSandboxUsable(config({ SANDBOX_MODE: 'bwrap' }))).not.toThrow()
  })

  test.if(linux)('refuses a pool the kernel could hand out as ephemeral ports', () => {
    expect(() =>
      assertSandboxUsable(config({ SANDBOX_MODE: 'bwrap', SANDBOX_PORT_MIN: '40000', SANDBOX_PORT_MAX: '40049' }))
    ).toThrow(/ip_local_port_range/)
  })
})

describe('a launched process', () => {
  test('is starting until it answers on its pod port, then running', async () => {
    const sandbox = launch(await workspace())

    expect(sandbox.status()).toBe('starting')
    await sandbox.ready()

    expect(sandbox.status()).toBe('running')
    expect(await get('127.0.0.1', sandbox.hostPort!)).toBe('ok')
  }, 30_000)

  test('fails with its last lines when it exits before answering, without waiting out its timeout', async () => {
    const sandbox = launch(await workspace(), { command: 'echo "boom: DATABASE_URL is not set"; exit 1' })
    const startedAt = Date.now()

    await expect(sandbox.ready()).rejects.toThrow('boom: DATABASE_URL is not set')
    expect(sandbox.status()).toBe('failed')
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  }, 30_000)

  test('fails and is killed when nothing answers within its ready timeout', async () => {
    const sandbox = launch(await workspace(), { command: 'sleep 60', readyTimeoutMs: 1500 })

    await expect(sandbox.ready()).rejects.toThrow()
    await sandbox.exited()

    expect(sandbox.status()).toBe('failed')
    expect(await canBind(sandbox.hostPort!)).toBe(true)
  }, 30_000)

  test('stops on kill, frees its pod port and keeps its logs', async () => {
    const sandbox = launch(await workspace())
    await sandbox.ready()

    await sandbox.kill()

    expect(sandbox.status()).toBe('stopped')
    expect(await get('127.0.0.1', sandbox.hostPort!)).toBeNull()
    expect(await canBind(sandbox.hostPort!)).toBe(true)
    expect(await sandbox.logs(10, true)).toContain('listening')
  }, 30_000)

  test('stays failed when killed after it ended', async () => {
    const sandbox = launch(await workspace(), { command: 'exit 1' })
    await sandbox.exited()

    await sandbox.kill()

    expect(sandbox.status()).toBe('failed')
  }, 30_000)

  test('is idle only when nothing holds it and its last use ended more than idleMs ago', async () => {
    const sandbox = start(await workspace(), { command: 'sleep 30' })

    const first = sandbox.use()
    const second = sandbox.use()
    first()
    first()
    await Bun.sleep(5)
    expect(sandbox.isIdle(0)).toBe(false)

    second()
    await Bun.sleep(5)
    expect(sandbox.isIdle(0)).toBe(true)
    expect(sandbox.isIdle(60_000)).toBe(false)
  })
})

describe('a command without a port', () => {
  test('is running from the start and stopped when it ends, with its exit code', async () => {
    const sandbox = start(await workspace(), { command: 'exit 7' })

    expect(sandbox.status()).toBe('running')
    expect(await sandbox.exited()).toBe(7)
    expect(sandbox.status()).toBe('stopped')
    expect((await run(await workspace(), 'true')).exitCode).toBe(0)
  }, 30_000)

  test('stops on kill', async () => {
    const sandbox = start(await workspace(), { command: 'sleep 300' })

    await sandbox.kill()

    expect(sandbox.status()).toBe('stopped')
  }, 30_000)

  test('runs in its workspace folder with the env it was given and nothing else of the server', async () => {
    process.env.RUNNER_SECRET = 'do-not-leak'
    const { exitCode, output } = await run(await workspace({ 'package.json': '{}' }), 'ls; env', {
      env: { API_URL: 'https://api.example' },
    })
    delete process.env.RUNNER_SECRET

    expect(exitCode).toBe(0)
    expect(output).toContain('package.json')
    expect(output).toContain('API_URL=https://api.example')
    expect(output).toContain('PATH=')
    expect(output).not.toContain('RUNNER_SECRET')
    if (linux) {
      expect(output).toContain('HOME=/tmp')
      expect(output).toContain('HTTPS_PROXY=http://127.0.0.1:3128')
    } else {
      expect(output).not.toContain('HTTPS_PROXY')
    }
  }, 30_000)
})

describe('logs', () => {
  test('hold stdout and stderr together, in the order written', async () => {
    const { output } = await run(await workspace(), 'echo one; echo two >&2; echo three')

    expect(output).toBe('one\ntwo\nthree\n')
  }, 30_000)

  test('come back as written, or cleaned of colour codes and blank lines', async () => {
    const sandbox = start(await workspace(), { command: "printf '\\033[31mred\\033[0m\\n\\nplain\\n'" })
    await sandbox.exited()

    expect(await sandbox.logs(10)).toEqual(['\u001b[31mred\u001b[0m', '', 'plain', ''])
    expect(await sandbox.logs(10, true)).toEqual(['red', 'plain'])
  }, 30_000)

  test('are the last tail lines', async () => {
    const sandbox = start(await workspace(), { command: 'seq 1 5' })
    await sandbox.exited()

    expect(await sandbox.logs(2, true)).toEqual(['4', '5'])
  }, 30_000)

  test('look back no further than the last 1 MB', async () => {
    const sandbox = start(await workspace(), {
      command: "echo FIRST; head -c 3000000 /dev/zero | tr '\\0' x; echo; echo END",
    })
    await sandbox.exited()

    const text = (await sandbox.logs(5000)).join('\n')
    expect(text).toHaveLength(1024 * 1024)
    expect(text.endsWith('x\nEND\n')).toBe(true)
    expect(text).not.toContain('FIRST')
  }, 30_000)

  test('are gone once deleted', async () => {
    const sandbox = start(await workspace(), { command: 'echo hello' })
    await sandbox.exited()
    const before = await readdir(join(tmpdir(), 'sandbox-logs'))

    await sandbox.deleteLogs()

    expect(await sandbox.logs(10)).toEqual([])
    expect(await readdir(join(tmpdir(), 'sandbox-logs'))).toHaveLength(before.length - 1)
  }, 30_000)
})

describe.if(linux)('confinement', () => {
  test("sees its own folder at /workspace and nothing else of the pod's files", async () => {
    const ws = await workspace({ 'package.json': '{}' })
    const other = await workspace({ secret: 'x' })

    const { output } = await run(
      ws,
      [
        'pwd',
        'echo hello > /workspace/written',
        'touch /usr/tampered 2>/dev/null && echo usr-writable',
        `ls ${other.dir} 2>/dev/null && echo other-workspace-visible`,
        `cat ${join(process.cwd(), 'package.json')} >/dev/null 2>&1 && echo server-visible`,
        'echo "home=$HOME"',
      ].join('; ')
    )

    expect(output).toStartWith('/workspace\n')
    expect(await readFile(join(ws.dir, 'written'), 'utf8')).toBe('hello\n')
    expect(output).not.toContain('usr-writable')
    expect(output).not.toContain('other-workspace-visible')
    expect(output).not.toContain('server-visible')
    expect(output).toContain('home=/tmp')
  }, 30_000)

  test("can't loosen its own firewall", async () => {
    const { exitCode, output } = await run(await workspace(), 'nft flush ruleset')

    expect(exitCode).not.toBe(0)
    expect(output).toMatch(/Operation not permitted|not found/)
  }, 30_000)

  test("keeps every process of a workspace in the workspace's cgroup, under its limits", async () => {
    const ws = await workspace()
    start(ws, { command: 'sleep 30' })
    start(ws, { command: 'sleep 30' })
    await until(async () => (await cgroupProcs(ws.id)) >= 2, 'both in the cgroup')

    const cgroup = join('/sys/fs/cgroup', `workspace-${ws.id}`)
    expect((await readFile(join(cgroup, 'memory.max'), 'utf8')).trim()).toBe(String(256 * 1024 * 1024))
    expect((await readFile(join(cgroup, 'cpu.max'), 'utf8')).trim()).toBe('100000 100000')
    expect((await readFile(join(cgroup, 'pids.max'), 'utf8')).trim()).toBe('128')
  }, 30_000)

  test('stops a workspace that forks without end at its process limit', async () => {
    const { output } = await run(await workspace(), 'for i in $(seq 200); do sleep 5 & done; wait')

    expect(output).toMatch(/fork|Resource temporarily unavailable/i)
  }, 30_000)

  test('kills a workspace that uses more memory than its limit', async () => {
    const { exitCode, output } = await run(
      await workspace(),
      `bun -e "const b = []; for (let i = 0; i < 40; i++) b.push(Buffer.alloc(16 * 1024 * 1024, 1)); console.log('survived')"`
    )

    expect(exitCode).not.toBe(0)
    expect(output).not.toContain('survived')
  }, 30_000)

  test('ends everything inside on kill', async () => {
    const ws = await workspace()
    const sandbox = start(ws, { command: 'sleep 300 & sleep 300 & wait' })
    await until(async () => (await cgroupProcs(ws.id)) >= 3, 'all running')

    await sandbox.kill()

    await until(async () => (await cgroupProcs(ws.id)) === 0, 'all gone')
  }, 30_000)
})

describe.if(linux)('network', () => {
  const clusterIp = process.env.TEST_DB_HOST ?? ''
  let podIp = ''
  let servers: ReturnType<typeof Bun.serve>[] = []

  beforeAll(() => {
    podIp =
      Object.values(networkInterfaces())
        .flat()
        .find(address => address?.family === 'IPv4' && !address.internal && address.address !== clusterIp)
        ?.address ?? ''
    servers = [
      Bun.serve({ hostname: '127.0.0.1', port: 4002, fetch: () => new Response('internal api') }),
      Bun.serve({ hostname: podIp, port: 4003, fetch: () => new Response('pod service') }),
      Bun.serve({ hostname: clusterIp, port: 5432, fetch: () => new Response('cluster service') }),
    ]
  })

  afterAll(() => {
    for (const server of servers) server.stop(true)
  })

  test("serves a launch on the pod's 127.0.0.1:<port> and nowhere else", async () => {
    const sandbox = launch(await workspace())
    await sandbox.ready()

    expect(await get('127.0.0.1', sandbox.hostPort!)).toBe('ok')
    expect(await get(podIp, sandbox.hostPort!)).toBeNull()
    expect(await get('127.0.0.1', 3000)).toBeNull()
  }, 30_000)

  test('opens nothing on the pod for a command without a port', async () => {
    const sandbox = start(await workspace(), { command: SERVER, env: { PORT: '3000' } })
    await Bun.sleep(1500)

    expect(sandbox.status()).toBe('running')
    expect(await get('127.0.0.1', 3000)).toBeNull()
  }, 30_000)

  test('reaches the internet through the proxy: a web page, an npm lookup and an API call from code', async () => {
    const { output } = await run(
      await workspace({ 'package.json': '{ "name": "probe" }' }),
      [
        "curl -sSL -o /dev/null -w '%{http_code}\\n' https://www.google.com/",
        'bun info left-pad version',
        `bun -e "console.log((await fetch('https://registry.npmjs.org/left-pad/latest')).status)"`,
      ].join('; ')
    )

    expect(output.split('\n').filter(Boolean)).toEqual(['200', '1.3.0', '200'])
  }, 60_000)

  test('applies its network rules to each host: allowed hosts get through, denied ones get 403', async () => {
    const { output } = await run(
      await workspace(),
      [
        "curl -s -o /dev/null -w '%{http_connect} %{http_code}\\n' https://registry.npmjs.org/left-pad",
        "curl -s -o /dev/null -w '%{http_connect} %{http_code}\\n' https://www.google.com/",
      ].join('; '),
      { network: { deny: ['*'], allow: ['registry.npmjs.org'] } }
    )

    expect(output.split('\n').filter(Boolean)).toEqual(['200 200', '403 000'])
  }, 60_000)

  test('never reaches the pod, the cluster or other sandboxes', async () => {
    const sibling = launch(await workspace())
    await sibling.ready()

    const { output } = await run(
      await workspace(),
      [
        'curl -s -m 3 http://127.0.0.1:4002/',
        `curl -s -m 3 http://127.0.0.1:${sibling.hostPort}/`,
        `curl -s -m 3 -o /dev/null -w '%{http_code}\\n' http://${podIp}:4003/`,
        `curl -s -m 3 -o /dev/null -w '%{http_code}\\n' http://${clusterIp}:5432/`,
        `curl -s -m 3 --noproxy '*' http://${podIp}:4003/`,
        `curl -s -m 3 --noproxy '*' http://${clusterIp}:5432/`,
        'echo done',
      ].join('; ')
    )

    expect(output.split('\n').filter(Boolean)).toEqual(['403', '403', 'done'])
  }, 60_000)

  test("blocks tools that don't use the proxy", async () => {
    const { output } = await run(await workspace(), "curl -s -m 5 --noproxy '*' https://www.google.com/ || echo blocked")

    expect(output.trim()).toBe('blocked')
  }, 30_000)

  test("an exec joined to a launch reaches it on localhost and follows the launch's rules", async () => {
    const ws = await workspace()
    const launched = launch(ws, { network: { deny: ['*'], allow: ['registry.npmjs.org'] } })
    await launched.ready()

    const { output } = await run(
      ws,
      [
        'curl -s http://localhost:3000/; echo',
        "curl -s -o /dev/null -w '%{http_connect} %{http_code}\\n' https://registry.npmjs.org/left-pad",
        "curl -s -o /dev/null -w '%{http_connect} %{http_code}\\n' https://www.google.com/",
      ].join('; '),
      { joinPid: launched.pid, env: { PORT: '3000' } }
    )

    expect(output.split('\n').filter(Boolean)).toEqual(['ok', '200 200', '403 000'])
  }, 60_000)

  test("an exec started together with a launch joins the launch's network once it is locked down, never the pod's", async () => {
    const podNetwork = readlinkSync('/proc/self/ns/net')

    for (let round = 0; round < 10; round++) {
      const ws = await workspace()
      const launched = launch(ws)

      const { exitCode, output } = await run(
        ws,
        `readlink /proc/self/ns/net; curl -s -m 1 --noproxy '*' http://${clusterIp}:5432/ || echo blocked`,
        { joinPid: launched.pid }
      )
      const [network, reach] = output.split('\n')

      expect(exitCode).toBe(0)
      expect(network).toMatch(/^net:\[\d+\]$/)
      expect(network).not.toBe(podNetwork)
      expect(reach).toBe('blocked')
      await launched.kill()
    }
  }, 120_000)
})

describe.if(linux)('deps', () => {
  test('an install in one exec is used by the launch and by later execs, and stays out of the workspace folder', async () => {
    const ws = await workspace({ 'package.json': '{ "name": "probe" }' })
    const { mounts } = await depsCache(join(root, 'deps')).mounts(ws.id, ws.dir)

    const install = await run(ws, 'bun add left-pad@1.3.0', { mounts })
    expect(install.exitCode).toBe(0)

    const launched = launch(ws, {
      mounts,
      command: `bun -e "const pad = require('left-pad'); Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response(pad('ok', 4)) })"`,
    })
    await launched.ready()
    expect(await get('127.0.0.1', launched.hostPort!)).toBe('  ok')

    expect((await run(ws, 'ls node_modules', { mounts })).output).toContain('left-pad')
    expect(await readdir(mounts[0]!.source)).toContain('left-pad')
    expect(await readdir(join(ws.dir, 'node_modules'))).toEqual([])
  }, 60_000)
})
