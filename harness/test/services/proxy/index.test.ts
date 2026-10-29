import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { once } from 'node:events'
import https from 'node:https'
import net, { type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { loadConfig } from '../../../src/config.ts'
import { proxy } from '../../../src/plugins/proxy.ts'
import { workers } from '../../../src/plugins/workers.ts'
import { createPlacementService } from '../../../src/services/placement/index.ts'
import { WORKSPACE_APP_HEADER } from '../../../src/services/sandbox/port-forwarder.ts'
import { createCsr } from '../../../src/services/workers/index.ts'
import { buildTestApp } from '../../test-app.ts'
import { createTestCa } from '../../worker-ca.ts'

const ca = await createTestCa()
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
await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve))

afterAll(async () => {
  worker.close()
  await app.close()
})

const sandboxIdleMs = app.config.SANDBOX_IDLE_MS
let id: string

beforeEach(async () => {
  upgrades.length = 0
  id = crypto.randomUUID()

  const placement = createPlacementService({
    redis: app.redis,
    workerName: 'worker-0',
    sandboxIdleMs,
    browserIdleMs: app.config.BROWSER_IDLE_MS,
  })
  await app.redis.hset('pods:worker-0', {
    address: `127.0.0.1:${(worker.address() as AddressInfo).port}`,
    bootId: placement.bootId,
    reportedAt: Date.now(),
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
