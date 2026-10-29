import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import RedisMock from 'ioredis-mock'

import { createRedisLog, readRedisLog } from '../../../src/services/sandbox/log.ts'

const KEY = 'launch-logs:ws-1'

let redis: InstanceType<typeof RedisMock>
const logs: ReturnType<typeof createRedisLog>[] = []

const open = () => {
  const log = createRedisLog(redis, KEY)
  logs.push(log)
  return log
}

beforeEach(async () => {
  redis = new RedisMock()
  await redis.flushall()
})

afterEach(async () => {
  for (const log of logs.splice(0)) await log.remove()
})

describe('a Redis log', () => {
  test('starts the key empty, clearing the last launch', async () => {
    await redis.set(KEY, 'from the last launch')

    open()
    await Bun.sleep(20)

    expect(await redis.get(KEY)).toBeNull()
  })

  test('copies what is written to the key within a second, without colour codes or blank lines', async () => {
    const log = open()

    log.write('\u001b[32mready\u001b[0m\n\n  \nGET / 200\n')

    await Bun.sleep(1300)
    expect(await readRedisLog(redis, KEY, 10)).toEqual(['ready', 'GET / 200'])
  })

  test('copies once more on remove, then reads the key as its tail', async () => {
    const log = open()
    log.write('exited with code 1\n')

    await log.remove()

    expect(await readRedisLog(redis, KEY, 10)).toEqual(['exited with code 1'])
    expect(await log.tail(10)).toEqual(['exited with code 1'])
  })

  test('reads its own file as its tail until removed', async () => {
    const log = open()

    log.write('one\ntwo\n')

    expect(await log.tail(10, true)).toEqual(['one', 'two'])
    expect(await redis.get(KEY)).toBeNull()
  })

  test('keeps the last 1,000 lines, for 24 hours', async () => {
    const log = open()
    log.write(Array.from({ length: 1500 }, (_, i) => `line ${i}`).join('\n') + '\n')

    await log.remove()

    const lines = await readRedisLog(redis, KEY, 5000)
    expect(lines).toHaveLength(1000)
    expect(lines.at(-1)).toBe('line 1499')
    expect(await redis.ttl(KEY)).toBeGreaterThan(24 * 60 * 60 - 10)
  })

  test("keeps each key's lines apart", async () => {
    const first = open()
    const second = createRedisLog(redis, 'launch-logs:ws-2')
    logs.push(second)
    first.write('from ws-1\n')
    second.write('from ws-2\n')

    await first.remove()
    await second.remove()

    expect(await readRedisLog(redis, KEY, 10)).toEqual(['from ws-1'])
    expect(await readRedisLog(redis, 'launch-logs:ws-2', 10)).toEqual(['from ws-2'])
  })
})

describe('readRedisLog', () => {
  test('is empty for a key never written', async () => {
    expect(await readRedisLog(redis, KEY, 10)).toEqual([])
  })

  test('is the last count lines', async () => {
    await redis.set(KEY, 'one\ntwo\nthree')

    expect(await readRedisLog(redis, KEY, 2)).toEqual(['two', 'three'])
  })
})
