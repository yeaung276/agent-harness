import { afterAll, describe, expect, test } from 'bun:test'

import { buildApp } from '../../../src/app.ts'
import { loadConfig } from '../../../src/config.ts'
import { createTestCa } from '../../worker-ca.ts'

const ca = await createTestCa()
const app = await buildApp(
  loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://127.0.0.1:1/none',
    REDIS_URL: 'redis://127.0.0.1:1',
    DATA_ENCRYPTION_KEY: '0'.repeat(64),
    WORKER_CA_KEY: ca.key,
    WORKER_CA_CERT: ca.cert,
  })
)

afterAll(() => app.close())

describe('GET /healthz', () => {
  test('answers ok', async () => {
    const res = await app.inject('/healthz')

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})

describe('GET /readyz', () => {
  test('answers 503 when Postgres and Redis are unreachable', async () => {
    const res = await app.inject('/readyz')

    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ status: 'not-ready', checks: { postgres: 'down', redis: 'down' } })
  })
})
