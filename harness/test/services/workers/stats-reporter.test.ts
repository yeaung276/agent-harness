import { describe, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs/promises'

import Fastify from 'fastify'
import fp from 'fastify-plugin'
import RedisMock from 'ioredis-mock'

import { loadConfig } from '../../../src/config.ts'
import { createStatsReporter } from '../../../src/services/workers/stats-reporter.ts'

const MB = 1024 * 1024
const redis = new RedisMock()

// cgroup files a test sets, by path under /sys/fs/cgroup; every other file is read from disk
let cgroupFiles: Record<string, string> = {}
const { readFile } = fs
mock.module('node:fs/promises', () => ({
  ...fs,
  readFile: (path: string, ...rest: never[]) => {
    const file = cgroupFiles[path.replace('/sys/fs/cgroup/', '')]
    return file === undefined ? readFile(path, ...rest) : Promise.resolve(file)
  },
}))

const counts = { sandboxes: 2, sessions: 3 }
const listeners: ((event?: string) => void)[] = []
const manager = (count: () => number) => ({
  count,
  onChange: (listener: (event?: string) => void) => void listeners.push(listener),
})

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

  test('reports how many execs are running', async () => {
    listeners.length = 0
    const app = await startWorker()
    await Bun.sleep(50)

    listeners[0]!('exec-start')
    listeners[0]!('exec-start')
    listeners[0]!('exec-end')
    await Bun.sleep(50)

    expect(await redis.hget('pods:worker-0', 'execs')).toBe('1')

    await app.close()
  })

  test("counts the kernel's reclaimable cache in the sandboxes as free memory", async () => {
    cgroupFiles = {
      'sandboxes/memory.max': String(1000 * MB),
      'sandboxes/memory.current': String(800 * MB),
      'sandboxes/memory.stat': `inactive_file ${50 * MB}\nslab_reclaimable ${600 * MB}\n`,
    }
    const app = await startWorker()
    await Bun.sleep(50)

    expect(await redis.hget('pods:worker-0', 'sandboxMemoryFreeBytes')).toBe(String(850 * MB))

    await app.close()
    cgroupFiles = {}
  })
})
