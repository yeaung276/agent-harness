import { beforeEach, describe, expect, test } from 'bun:test'

import RedisMock from 'ioredis-mock'

import { createPlacementService } from '../../../src/services/placement/index.ts'

const SANDBOX_IDLE_MS = 15 * 60 * 1000
const BROWSER_IDLE_MS = 5 * 60 * 1000
const GB = 1024 ** 3

const redis = new RedisMock()

const placement = (workerName?: string) =>
  createPlacementService({
    redis,
    workerName,
    sandboxIdleMs: SANDBOX_IDLE_MS,
    browserIdleMs: BROWSER_IDLE_MS,
  })

const server = placement()

type Load = { sandboxes?: number; memoryGb?: number; memoryLimitGb?: number | null; sessions?: number }

// a worker that reports as the stats reporter does: HSET pods:<name>, then EXPIRE 30
const startWorker = (name: string, address: string) => {
  const own = placement(name)

  return {
    ...own,
    name,
    report: async ({ sandboxes = 0, memoryGb = 1, memoryLimitGb = 8, sessions = 0 }: Load = {}) => {
      await redis
        .multi()
        .hset(`pods:${name}`, {
          hostname: name,
          address,
          bootId: own.bootId,
          reportedAt: Date.now(),
          cpuPercent: 12,
          memoryBytes: memoryGb * GB,
          ...(memoryLimitGb === null ? {} : { memoryLimitBytes: memoryLimitGb * GB }),
          sandboxes,
          sandboxSlots: 50,
          sessions,
        })
        .expire(`pods:${name}`, 30)
        .exec()
    },
  }
}

// what the server writes at registration, before the worker's first report
const register = (name: string, address: string) => redis.hset(`pods:${name}`, { hostname: name, address })

const expireStats = async (name: string) => {
  await redis.pexpire(`pods:${name}`, 1)
  await Bun.sleep(5)
}

beforeEach(async () => {
  await redis.flushall()
})

describe('the most free worker', () => {
  test('no worker reporting is a 503', async () => {
    await expect(server.workspace('ws-1', 'new')).rejects.toMatchObject({ status: 503 })
    await expect(server.workspace('ws-1', 'any')).rejects.toMatchObject({ status: 503 })
    await expect(server.session(null, null)).rejects.toMatchObject({ status: 503 })
  })

  test('a worker that registered but has not reported yet is not picked', async () => {
    await register('worker-0', '10.0.0.5:3000')
    await expect(server.workspace('ws-1', 'new')).rejects.toMatchObject({ status: 503 })

    const worker1 = startWorker('worker-1', '10.0.0.6:3000')
    await worker1.report({ sandboxes: 49 })
    expect(await server.workspace('ws-1', 'new')).toBe('worker-1')
  })

  test('the most free sandbox slots win', async () => {
    await startWorker('worker-0', '10.0.0.5:3000').report({ sandboxes: 10, memoryGb: 1, sessions: 0 })
    await startWorker('worker-1', '10.0.0.6:3000').report({ sandboxes: 3, memoryGb: 7, sessions: 20 })
    await startWorker('worker-2', '10.0.0.7:3000').report({ sandboxes: 7 })

    expect(await server.workspace('ws-1', 'new')).toBe('worker-1')
  })

  test('equal slots: the lower share of memory wins', async () => {
    await startWorker('worker-0', '10.0.0.5:3000').report({ sandboxes: 4, memoryGb: 6, memoryLimitGb: 8 })
    await startWorker('worker-1', '10.0.0.6:3000').report({ sandboxes: 4, memoryGb: 6, memoryLimitGb: 16 })

    expect(await server.workspace('ws-1', 'new')).toBe('worker-1')
  })

  test('a worker without a memory limit counts as using none of it', async () => {
    await startWorker('worker-0', '10.0.0.5:3000').report({ sandboxes: 4, memoryGb: 1, memoryLimitGb: 8 })
    await startWorker('worker-1', '10.0.0.6:3000').report({ sandboxes: 4, memoryGb: 6, memoryLimitGb: null })

    expect(await server.workspace('ws-1', 'new')).toBe('worker-1')
  })

  test('equal slots and memory: the fewer sessions win', async () => {
    await startWorker('worker-0', '10.0.0.5:3000').report({ sandboxes: 2, memoryGb: 2, sessions: 9 })
    await startWorker('worker-1', '10.0.0.6:3000').report({ sandboxes: 2, memoryGb: 2, sessions: 1 })

    expect(await server.workspace('ws-1', 'new')).toBe('worker-1')
  })

  test('a worker whose stats expired is not picked', async () => {
    const worker0 = startWorker('worker-0', '10.0.0.5:3000')
    await worker0.report({ sandboxes: 0 })
    await startWorker('worker-1', '10.0.0.6:3000').report({ sandboxes: 40 })

    await expireStats('worker-0')

    expect(await server.workspace('ws-1', 'new')).toBe('worker-1')
  })
})

describe('a workspace with nothing running', () => {
  beforeEach(async () => {
    await startWorker('worker-0', '10.0.0.5:3000').report({ sandboxes: 30 })
    await startWorker('worker-1', '10.0.0.6:3000').report({ sandboxes: 5 })
  })

  test('launch goes to the most free worker', async () => {
    expect(await server.workspace('ws-1', 'new')).toBe('worker-1')
  })

  test('exec and app traffic go to the most free worker', async () => {
    expect(await server.workspace('ws-1', 'any')).toBe('worker-1')
  })

  test('logs and stop are a 409', async () => {
    await expect(server.workspace('ws-1', 'running')).rejects.toMatchObject({
      status: 409,
      message: 'Nothing is running in this workspace',
    })
  })
})

describe('a workspace running on a worker', () => {
  let worker0: ReturnType<typeof startWorker>

  beforeEach(async () => {
    // the busier worker holds it, so following the key and picking the most free differ
    worker0 = startWorker('worker-0', '10.0.0.5:3000')
    await worker0.report({ sandboxes: 30 })
    await startWorker('worker-1', '10.0.0.6:3000').report({ sandboxes: 5 })
    await worker0.claimWorkspace('ws-1')
  })

  test('launch is a 409', async () => {
    await expect(server.workspace('ws-1', 'new')).rejects.toMatchObject({
      status: 409,
      message: 'A background process is already running',
    })
  })

  test('exec, app traffic, logs and stop go to its worker', async () => {
    expect(await server.workspace('ws-1', 'any')).toBe('worker-0')
    expect(await server.workspace('ws-1', 'running')).toBe('worker-0')
  })

  test('another workspace still goes to the most free worker', async () => {
    expect(await server.workspace('ws-2', 'new')).toBe('worker-1')
  })

  test('a lookup renews the key to the sandbox idle time', async () => {
    await redis.pexpire('placement:workspace:ws-1', 1000)

    await server.workspace('ws-1', 'any')

    expect(await redis.pttl('placement:workspace:ws-1')).toBeGreaterThan(SANDBOX_IDLE_MS - 1000)
  })

  test('once stopped, it is placed by load again', async () => {
    await worker0.releaseWorkspace('ws-1')

    expect(await server.workspace('ws-1', 'new')).toBe('worker-1')
    await expect(server.workspace('ws-1', 'running')).rejects.toMatchObject({ status: 409 })
  })

  test('the key expiring is the same as a stop', async () => {
    await redis.pexpire('placement:workspace:ws-1', 1)
    await Bun.sleep(5)

    expect(await server.workspace('ws-1', 'any')).toBe('worker-1')
  })

  test('its worker stops reporting: the key is removed and the workspace is placed by load', async () => {
    await expireStats('worker-0')

    await expect(server.workspace('ws-1', 'running')).rejects.toMatchObject({ status: 409 })
    expect(await redis.exists('placement:workspace:ws-1')).toBe(0)
    expect(await server.workspace('ws-1', 'new')).toBe('worker-1')
  })

  test('its worker restarts under the same name: the old boot no longer counts', async () => {
    const restarted = startWorker('worker-0', '10.0.0.5:3000')
    await restarted.report({ sandboxes: 0 })

    // worker-0 is now the most free, but it no longer runs ws-1
    await expect(server.workspace('ws-1', 'running')).rejects.toMatchObject({ status: 409 })
    expect(await redis.exists('placement:workspace:ws-1')).toBe(0)
    expect(await server.workspace('ws-1', 'new')).toBe('worker-0')
  })
})

describe('claiming a workspace', () => {
  test('the claim holds the worker and its boot, for the sandbox idle time', async () => {
    const worker0 = startWorker('worker-0', '10.0.0.5:3000')
    await worker0.claimWorkspace('ws-1')

    expect(await redis.get('placement:workspace:ws-1')).toBe(`worker-0:${worker0.bootId}`)
    expect(await redis.pttl('placement:workspace:ws-1')).toBeGreaterThan(SANDBOX_IDLE_MS - 1000)
  })

  test('the same worker claiming again succeeds and renews the key', async () => {
    const worker0 = startWorker('worker-0', '10.0.0.5:3000')
    await worker0.claimWorkspace('ws-1')
    await redis.pexpire('placement:workspace:ws-1', 1000)

    await worker0.claimWorkspace('ws-1')

    expect(await redis.pttl('placement:workspace:ws-1')).toBeGreaterThan(SANDBOX_IDLE_MS - 1000)
  })

  test('another worker claiming is a 409 and leaves the key alone', async () => {
    const worker0 = startWorker('worker-0', '10.0.0.5:3000')
    const worker1 = startWorker('worker-1', '10.0.0.6:3000')
    await worker0.claimWorkspace('ws-1')

    await expect(worker1.claimWorkspace('ws-1')).rejects.toMatchObject({
      status: 409,
      message: 'This workspace is running on another worker',
    })
    expect(await redis.get('placement:workspace:ws-1')).toBe(`worker-0:${worker0.bootId}`)
  })

  test('two workers claiming at once: exactly one wins', async () => {
    const workers = [startWorker('worker-0', '10.0.0.5:3000'), startWorker('worker-1', '10.0.0.6:3000')]

    const results = await Promise.allSettled(workers.map(worker => worker.claimWorkspace('ws-1')))

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })

  test('another worker releasing leaves the key alone', async () => {
    const worker0 = startWorker('worker-0', '10.0.0.5:3000')
    await worker0.claimWorkspace('ws-1')

    await startWorker('worker-1', '10.0.0.6:3000').releaseWorkspace('ws-1')

    expect(await redis.get('placement:workspace:ws-1')).toBe(`worker-0:${worker0.bootId}`)
  })

  test("an old boot's release leaves the new boot's key alone", async () => {
    const oldBoot = startWorker('worker-0', '10.0.0.5:3000')
    const newBoot = startWorker('worker-0', '10.0.0.5:3000')
    await newBoot.claimWorkspace('ws-1')

    await oldBoot.releaseWorkspace('ws-1')

    expect(await redis.get('placement:workspace:ws-1')).toBe(`worker-0:${newBoot.bootId}`)
  })

  test('the holder releasing deletes the key', async () => {
    const worker0 = startWorker('worker-0', '10.0.0.5:3000')
    await worker0.claimWorkspace('ws-1')

    await worker0.releaseWorkspace('ws-1')

    expect(await redis.exists('placement:workspace:ws-1')).toBe(0)
  })
})

describe('browser sessions', () => {
  let worker0: ReturnType<typeof startWorker>
  let worker1: ReturnType<typeof startWorker>

  beforeEach(async () => {
    worker0 = startWorker('worker-0', '10.0.0.5:3000')
    worker1 = startWorker('worker-1', '10.0.0.6:3000')
    await worker0.report({ sandboxes: 30 })
    await worker1.report({ sandboxes: 5 })
  })

  test('a new session without a workspace goes to the most free worker', async () => {
    expect(await server.session(null, null)).toBe('worker-1')
  })

  test('a new session for a workspace with nothing running goes to the most free worker', async () => {
    expect(await server.session(null, 'ws-1')).toBe('worker-1')
  })

  test("a new session for a running workspace goes to the workspace's worker", async () => {
    await worker0.claimWorkspace('ws-1')

    expect(await server.session(null, 'ws-1')).toBe('worker-0')
  })

  test('every call on an open session goes to the worker holding its tab', async () => {
    await worker0.claimSession('session-1')

    expect(await server.session('session-1', null)).toBe('worker-0')
    // even when its workspace is running elsewhere
    await worker1.claimWorkspace('ws-1')
    expect(await server.session('session-1', 'ws-1')).toBe('worker-0')
  })

  test('the claim holds the worker and its boot, for the browser idle time', async () => {
    await worker0.claimSession('session-1')

    expect(await redis.get('placement:session:session-1')).toBe(`worker-0:${worker0.bootId}`)
    expect(await redis.pttl('placement:session:session-1')).toBeGreaterThan(BROWSER_IDLE_MS - 1000)
  })

  test('a lookup renews the key to the browser idle time', async () => {
    await worker0.claimSession('session-1')
    await redis.pexpire('placement:session:session-1', 1000)

    await server.session('session-1', null)

    expect(await redis.pttl('placement:session:session-1')).toBeGreaterThan(BROWSER_IDLE_MS - 1000)
  })

  test('an evicted session goes to the most free worker', async () => {
    await worker0.claimSession('session-1')
    await worker0.releaseSession('session-1')

    expect(await redis.exists('placement:session:session-1')).toBe(0)
    expect(await server.session('session-1', null)).toBe('worker-1')
  })

  test("an evicted session of a running workspace goes to the workspace's worker", async () => {
    await worker1.claimSession('session-1')
    await worker0.claimWorkspace('ws-1')
    await worker1.releaseSession('session-1')

    expect(await server.session('session-1', 'ws-1')).toBe('worker-0')
  })

  test('its worker stops reporting: the key is removed and the session is placed again', async () => {
    await worker0.claimSession('session-1')

    await expireStats('worker-0')

    expect(await server.session('session-1', null)).toBe('worker-1')
    expect(await redis.exists('placement:session:session-1')).toBe(0)
  })

  test('another worker releasing leaves the key alone', async () => {
    await worker0.claimSession('session-1')

    await worker1.releaseSession('session-1')

    expect(await redis.get('placement:session:session-1')).toBe(`worker-0:${worker0.bootId}`)
  })

  test('reopening a tab on another worker moves the session there', async () => {
    await worker0.claimSession('session-1')

    await worker1.claimSession('session-1')

    expect(await server.session('session-1', null)).toBe('worker-1')
  })
})
