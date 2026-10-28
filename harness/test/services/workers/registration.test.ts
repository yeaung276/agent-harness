import { afterAll, describe, expect, test } from 'bun:test'
import type { AddressInfo } from 'node:net'

import Fastify from 'fastify'

import { loadConfig } from '../../../src/config.ts'
import { workers } from '../../../src/plugins/workers.ts'
import { workerRoutes } from '../../../src/routes/workers/index.ts'
import { registerWithServer } from '../../../src/services/workers/registration.ts'
import { buildTestApp } from '../../test-app.ts'
import { createTestCa } from '../../worker-ca.ts'

const ca = await createTestCa()
const env = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://unused',
  REDIS_URL: 'redis://unused',
  DATA_ENCRYPTION_KEY: '0'.repeat(64),
  WORKER_JOIN_SECRET: 'j'.repeat(32),
}

const server = await buildTestApp(loadConfig({ ...env, WORKER_CA_KEY: ca.key, WORKER_CA_CERT: ca.cert }))
await server.register(workers)
await server.register(workerRoutes, { prefix: '/workers' })
await server.listen({ host: '127.0.0.1', port: 0 })

const registration = await registerWithServer(
  loadConfig({
    ...env,
    APP_MODE: 'worker',
    WORKER_NAME: 'worker-0',
    SERVER_URL: `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`,
  })
)

const worker = Fastify({ https: registration.https })
worker.get('/internal/ping', async () => ({ pong: true }))
await worker.listen({ host: '127.0.0.1', port: 0 })
const workerUrl = `https://127.0.0.1:${(worker.server.address() as AddressInfo).port}/internal/ping`

afterAll(async () => {
  await worker.close()
  await server.close()
})

const callAs = (client: { key: string; cert: string }) =>
  fetch(workerUrl, { tls: { ...client, ca: ca.cert, checkServerIdentity: () => undefined } })

describe('registerWithServer', () => {
  test('serves mTLS that the server certificate can call', async () => {
    const res = await callAs(server.workers.serverCert)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pong: true })
  })

  test('fails the handshake for a worker certificate in place of the server one', async () => {
    await expect(callAs({ key: registration.https.key, cert: registration.https.cert })).rejects.toThrow()
  })

  test('is reachable through the server call at its routing address', async () => {
    await server.redis.hset('pods:worker-0', 'address', new URL(workerUrl).host)
    const res = await server.workers.call('worker-0', '/internal/ping')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pong: true })
  })

  test('is not called without a routing address', async () => {
    await expect(server.workers.call('worker-9', '/internal/ping')).rejects.toMatchObject({ status: 503 })
  })

  test('fails the handshake without a client certificate', async () => {
    await expect(fetch(workerUrl, { tls: { ca: ca.cert, checkServerIdentity: () => undefined } })).rejects.toThrow()
  })
})
