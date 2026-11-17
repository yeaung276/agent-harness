import { describe, expect, test } from 'bun:test'

import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { HttpError } from '../src/services/http-error.ts'
import { createTestCa } from './worker-ca.ts'

const ca = await createTestCa()
const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://127.0.0.1:1/none',
  REDIS_URL: 'redis://127.0.0.1:1',
  DATA_ENCRYPTION_KEY: '0'.repeat(64),
  WORKER_JOIN_SECRET: 'j'.repeat(32),
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

  test('answers an unexpected error with a bare 500, and an intended one with its own status and message', async () => {
    const app = await buildApp(config)
    app.get('/unexpected', async () => {
      throw new Error('Failed query: insert ... params: secret')
    })
    app.get('/intended', async () => {
      throw new HttpError(503, 'No worker is available')
    })

    const unexpected = await app.inject('/unexpected')
    const intended = await app.inject('/intended')

    expect(unexpected.statusCode).toBe(500)
    expect(unexpected.json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    })
    expect(intended.statusCode).toBe(503)
    expect(intended.json().message).toBe('No worker is available')

    await app.close()
  })

  test('closes while Redis is unreachable', async () => {
    const app = await buildApp(config)
    await app.redis.connect().catch(() => {})

    await app.close()
  }, 1000)
})
