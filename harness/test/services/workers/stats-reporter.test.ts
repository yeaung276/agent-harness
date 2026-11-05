import { describe, expect, test } from 'bun:test'

import Fastify from 'fastify'
import fp from 'fastify-plugin'
import RedisMock from 'ioredis-mock'

import { loadConfig } from '../../../src/config.ts'
import { createStatsReporter } from '../../../src/services/workers/stats-reporter.ts'

const redis = new RedisMock()

const counts = { sandboxes: 2, sessions: 3 }
const listeners: (() => void)[] = []
const manager = (count: () => number) => ({ count, onChange: (listener: () => void) => void listeners.push(listener) })

const startWorker = async () => {
  const app = Fastify()
  app.decorate(
    'config',
    loadConfig({ DATABASE_URL: 'postgres://unused', REDIS_URL: 'redis://unused', DATA_ENCRYPTION_KEY: '0'.repeat(64) })
  )
  await app.register(fp(async app => void app.decorate('redis', redis), { name: 'redis' }))
  await app.register(
    fp(async app => void app.decorate('services', { placement: { bootId: 'boot-1' } } as never), { name: 'services' })
  )
  await app.register(
    fp(async app => void app.decorate('sandbox', manager(() => counts.sandboxes) as never), { name: 'sandbox' })
  )
  await app.register(
    fp(async app => void app.decorate('chromium', manager(() => counts.sessions) as never), { name: 'chromium' })
  )
  await app.register(createStatsReporter({ statsKey: 'pods:worker-0', hostname: 'worker-0', address: '10.0.0.5:3000' }))
  await app.listen({ host: '127.0.0.1', port: 0 })
  return app
}

describe('the stats reporter', () => {
  test('reports once the worker listens, and deregisters when it closes', async () => {
    const app = await startWorker()
    await Bun.sleep(50)

    expect(await redis.hgetall('pods:worker-0')).toMatchObject({
      hostname: 'worker-0',
      address: '10.0.0.5:3000',
      bootId: 'boot-1',
      sandboxes: '2',
      sandboxSlots: '50',
      sessions: '3',
    })
    expect(await redis.ttl('pods:worker-0')).toBeGreaterThan(0)

    await app.close()

    expect(await redis.exists('pods:worker-0')).toBe(0)
  })

  test('reports at once when a sandbox or browser manager changes, without waiting for the next tick', async () => {
    listeners.length = 0
    const app = await startWorker()
    await Bun.sleep(50)
    expect(listeners).toHaveLength(2)

    counts.sandboxes = 5
    listeners[0]!()
    await Bun.sleep(50)
    expect(await redis.hget('pods:worker-0', 'sandboxes')).toBe('5')

    counts.sessions = 7
    listeners[1]!()
    listeners[1]!()
    listeners[1]!()
    await Bun.sleep(50)
    expect(await redis.hget('pods:worker-0', 'sessions')).toBe('7')

    await app.close()
    Object.assign(counts, { sandboxes: 2, sessions: 3 })
  })
})
