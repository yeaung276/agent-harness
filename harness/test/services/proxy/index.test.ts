import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import net, { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'

import { loadConfig } from '../../../src/config.ts'
import { users } from '../../../src/db/schema.ts'
import { proxy } from '../../../src/plugins/proxy.ts'
import { workers } from '../../../src/plugins/workers.ts'
import { createPlacementService } from '../../../src/services/placement/index.ts'
import { WORKSPACE_APP_HEADER } from '../../../src/services/sandbox/port-forwarder.ts'
import { createCsr } from '../../../src/services/workers/index.ts'
import { buildTestApp } from '../../test-app.ts'
import { createTestCa } from '../../worker-ca.ts'

const ca = await createTestCa()
const workspacesDir = await mkdtemp(join(tmpdir(), 'proxy-test-'))
const app = await buildTestApp(
  loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://unused',
    REDIS_URL: 'redis://unused',
    DATA_ENCRYPTION_KEY: '0'.repeat(64),
    WORKER_CA_KEY: ca.key,
    WORKER_CA_CERT: ca.cert,
    PROXY_PORT: '0',
    WORKSPACES_DIR: workspacesDir,
  })
)
await app.register(workers)
await app.register(proxy)
await app.listen({ host: '127.0.0.1', port: 0 })
const proxyPort = (app.proxy.server.address() as AddressInfo).port

// worker-0's port forwarder, over the same mTLS the server calls it with
const { key, csr } = await createCsr('worker-0')
const { cert } = await app.workers.register({ hostname: 'worker-0', address: 'pending', csr })
const upgrades: { app: string | undefined; socket: Duplex }[] = []
const worker = https.createServer({ key, cert, ca: ca.cert, requestCert: true })
worker.on('upgrade', (req, socket) => {
  upgrades.push({ app: req.headers[WORKSPACE_APP_HEADER] as string | undefined, socket })
  socket.write('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n')
})
const theApp = (_req: IncomingMessage, res: ServerResponse) => res.end('the app')
let workerAnswers: (req: IncomingMessage, res: ServerResponse) => void = theApp
worker.on('request', (req, res) => workerAnswers(req, res))
await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve))

const [user] = await app.db
  .insert(users)
  .values({ email: `${crypto.randomUUID()}@example.com`, passwordHash: 'x' })
  .returning({ id: users.id })

afterAll(async () => {
  worker.close()
  await app.close()
  await rm(workspacesDir, { recursive: true, force: true })
})

const sandboxIdleMs = app.config.SANDBOX_IDLE_MS
let id: string

beforeEach(async () => {
  upgrades.length = 0
  workerAnswers = theApp
  id = crypto.randomUUID()

  const placement = createPlacementService({
    redis: app.redis,
    workerName: 'worker-0',
    sandboxIdleMs,
    browserIdleMs: app.config.BROWSER_IDLE_MS,
    minFreeMemoryMb: app.config.PLACEMENT_MIN_FREE_MEMORY_MB,
  })
  await app.redis.hset('pods:worker-0', {
    address: `127.0.0.1:${(worker.address() as AddressInfo).port}`,
    bootId: placement.bootId,
    reportedAt: Date.now(),
    sandboxSlots: 10,
    sandboxes: 0,
  })
  await app.redis.persist('pods:worker-0')
  await placement.claimWorkspace(id)
})

afterEach(() => {
  jest.useRealTimers()
})

const openSocket = async (workspaceId: string) => {
  const socket = net.connect(proxyPort, '127.0.0.1')
  socket.write(
    ['GET /hmr HTTP/1.1', `host: ${workspaceId}.localhost`, 'connection: Upgrade', 'upgrade: websocket', '', ''].join(
      '\r\n'
    )
  )
  const [first] = await once(socket, 'data')
  return { socket, status: String(first).split('\r\n')[0] }
}

const PAGE_LOAD = { 'sec-fetch-mode': 'navigate', accept: 'text/html' }

// a workspace with nothing running, so a request to it wakes it
const stopped = async () => (await app.services.workspaces.create(user!.id, `ws-${crypto.randomUUID().slice(0, 8)}`)).id

const load = (workspaceId: string, headers: Record<string, string>) =>
  new Promise<IncomingMessage>(resolve =>
    http.get(
      { host: '127.0.0.1', port: proxyPort, path: '/', headers: { host: `${workspaceId}.localhost`, ...headers } },
      resolve
    )
  )

const firstChunk = (res: IncomingMessage) =>
  new Promise<string>(resolve =>
    res.once('data', chunk => {
      res.pause()
      resolve(String(chunk))
    })
  )

const text = async (res: IncomingMessage) => {
  let body = ''
  for await (const chunk of res) body += chunk
  return body
}

// lets the renewal the advanced clock started reach Redis
const settle = async () => {
  jest.useRealTimers()
  await Bun.sleep(20)
}

describe('a websocket', () => {
  test("reaches the workspace's worker over mTLS, naming the workspace", async () => {
    const { socket, status } = await openSocket(id)
    socket.destroy()

    expect(status).toBe('HTTP/1.1 101 Switching Protocols')
    expect(upgrades.map(upgrade => upgrade.app)).toEqual([id])
  })

  test("renews the workspace's placement while it stays open", async () => {
    jest.useFakeTimers()
    const { socket } = await openSocket(id)
    await app.redis.pexpire(`placement:workspace:${id}`, 120_000)

    jest.advanceTimersByTime(60_000)
    await settle()
    socket.destroy()

    expect(await app.redis.pttl(`placement:workspace:${id}`)).toBeGreaterThan(120_000)
  })

  test('stops renewing once it closes', async () => {
    jest.useFakeTimers()
    const { socket } = await openSocket(id)
    socket.destroy()
    // the proxy stops renewing before it closes the worker's side
    await once(upgrades[0]!.socket, 'end')
    await app.redis.pexpire(`placement:workspace:${id}`, 120_000)

    jest.advanceTimersByTime(60_000)
    await settle()

    expect(await app.redis.pttl(`placement:workspace:${id}`)).toBeLessThanOrEqual(120_000)
  })
})

describe('a page load that wakes the workspace', () => {
  test('gets the waking page at once, then a reload once the worker answers', async () => {
    const held = Promise.withResolvers<ServerResponse>()
    workerAnswers = (_req, res) => held.resolve(res)

    const res = await load(await stopped(), PAGE_LOAD)
    const first = await firstChunk(res)
    ;(await held.promise).end('the app')
    const rest = await text(res)

    expect(res.statusCode).toBe(503)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(first).toContain('Waking up the workspace')
    expect(rest).toEndWith('<script>location.reload()</script></main></body></html>')
    expect(rest).not.toContain('the app')
  })

  test('shows why the workspace did not start, without reloading', async () => {
    workerAnswers = (_req, res) => {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('workspace <failed>')
    }

    const body = await text(await load(await stopped(), PAGE_LOAD))

    expect(body).toContain('Waking up the workspace')
    expect(body).toContain("It didn't start: workspace &lt;failed&gt;")
    expect(body).not.toContain('location.reload()')
  })

  test('is not sent to a fetch, which waits for the real answer', async () => {
    const res = await load(await stopped(), { 'sec-fetch-mode': 'cors', accept: '*/*' })

    expect(res.statusCode).toBe(200)
    expect(await text(res)).toBe('the app')
  })

  test('is not needed when the workspace is already running', async () => {
    const res = await load(id, PAGE_LOAD)

    expect(res.statusCode).toBe(200)
    expect(await text(res)).toBe('the app')
  })
})
