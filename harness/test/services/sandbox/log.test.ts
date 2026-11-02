import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import RedisMock from 'ioredis-mock'

import { createRedisLog, readRedisLog } from '../../../src/services/sandbox/log.ts'

const KEY = 'launch-log:ws-1'

let redis: InstanceType<typeof RedisMock>
const logs: ReturnType<typeof createRedisLog>[] = []

const open = (key = KEY) => {
  const log = createRedisLog(redis, key)
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
    await redis.rpush(KEY, 'from the last launch')

    await open().tail(10)

    expect(await redis.exists(KEY)).toBe(0)
  })

  test('sends each complete line as it is written, without colour codes or blank lines', async () => {
    const log = open()

    log.write('\u001b[32mready\u001b[0m\n\n  \nGET / 200\n')
    await log.tail(10)

    expect(await readRedisLog(redis, KEY, 10)).toEqual(['ready', 'GET / 200'])
  })

  test('holds a line until its newline, and joins a line split across writes', async () => {
    const log = open()

    log.write('listen')
    await log.tail(10)
    expect(await readRedisLog(redis, KEY, 10)).toEqual([])

    log.write('ing on 3000\n')
    await log.tail(10)
    expect(await readRedisLog(redis, KEY, 10)).toEqual(['listening on 3000'])
  })

  test('includes a line still waiting for its newline in its tail', async () => {
    const log = open()

    log.write('one\ntwo')

    expect(await log.tail(10)).toEqual(['one', 'two'])
  })

  test('sends the last line on remove, and reads the key as its tail after', async () => {
    const log = open()
    log.write('exited with code 1')

    await log.remove()

    expect(await readRedisLog(redis, KEY, 10)).toEqual(['exited with code 1'])
    expect(await log.tail(10)).toEqual(['exited with code 1'])
  })

  test('ignores writes once removed', async () => {
    const log = open()
    log.write('one\n')
    await log.remove()

    log.write('two\n')

    expect(await log.tail(10)).toEqual(['one'])
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
    const second = open('launch-log:ws-2')
    first.write('from ws-1\n')
    second.write('from ws-2\n')

    await first.remove()
    await second.remove()

    expect(await readRedisLog(redis, KEY, 10)).toEqual(['from ws-1'])
    expect(await readRedisLog(redis, 'launch-log:ws-2', 10)).toEqual(['from ws-2'])
  })
})

describe('readRedisLog', () => {
  test('is empty for a key never written', async () => {
    expect(await readRedisLog(redis, KEY, 10)).toEqual([])
  })

  test('is the last count lines', async () => {
    await redis.rpush(KEY, 'one', 'two', 'three')

    expect(await readRedisLog(redis, KEY, 2)).toEqual(['two', 'three'])
  })
})
