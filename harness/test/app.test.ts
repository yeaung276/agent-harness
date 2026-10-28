import { describe, expect, test } from 'bun:test'

import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { createTestCa } from './worker-ca.ts'

const ca = await createTestCa()
const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://127.0.0.1:1/none',
  REDIS_URL: 'redis://127.0.0.1:1',
  DATA_ENCRYPTION_KEY: '0'.repeat(64),
  WORKER_CA_KEY: ca.key,
  WORKER_CA_CERT: ca.cert,
})

describe('buildApp', () => {
  test('decorates config, db and redis', async () => {
    const app = await buildApp(config)

    expect(app.config).toEqual(config)
    expect(app.hasDecorator('db')).toBeTrue()
    expect(app.hasDecorator('redis')).toBeTrue()

    await app.close()
  })

  test('closes while Redis is unreachable', async () => {
    const app = await buildApp(config)
    await app.redis.connect().catch(() => {})

    await app.close()
  }, 1000)
})
