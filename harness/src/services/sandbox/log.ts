import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Redis } from 'ioredis'

const LOGS_DIR = join(tmpdir(), 'sandbox-logs')
const REDIS_MAX_LINES = 1000
const REDIS_TTL_SECONDS = 24 * 60 * 60

export type Log = {
  write: (text: string) => void
  tail: (count: number, clean?: boolean) => Promise<string[]>
  remove: () => Promise<void>
}

const cleanLines = (text: string) =>
  text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split('\n')
    .filter(line => line.trim())

export const createLog = (): Log => {
  mkdirSync(LOGS_DIR, { recursive: true })
  const path = join(LOGS_DIR, `${randomUUID()}.log`)
  const fd = openSync(path, 'a')
  let removed = false

  return {
    write: text => {
      if (!removed) writeSync(fd, text)
    },

    tail: async (count, clean = false) => {
      if (removed) return []

      const file = Bun.file(path)
      const text = await file.slice(Math.max(0, file.size - 1024 * 1024)).text()
      return (clean ? cleanLines(text) : text.split('\n')).slice(-count)
    },

    remove: async () => {
      if (removed) return
      removed = true
      closeSync(fd)
      await rm(path, { force: true })
    },
  }
}

// lines go to Redis as they are written, colour codes and blank lines left out; one connection keeps them in order
export const createRedisLog = (redis: Redis, key: string): Log => {
  let partial = ''
  let removed = false
  let sent: Promise<unknown> = redis.del(key).catch(() => null)

  const send = (lines: string[]) => {
    if (lines.length === 0) return
    sent = redis
      .multi()
      .rpush(key, ...lines)
      .ltrim(key, -REDIS_MAX_LINES, -1)
      .expire(key, REDIS_TTL_SECONDS)
      .exec()
      .catch(() => null)
  }

  return {
    write: text => {
      if (removed) return
      const lines = (partial + text).split('\n')
      partial = lines.pop()!
      send(cleanLines(lines.join('\n')))
    },

    tail: async count => {
      await sent
      return [...(await readRedisLog(redis, key, count)), ...cleanLines(partial)].slice(-count)
    },

    remove: async () => {
      if (!removed) send(cleanLines(partial))
      removed = true
      partial = ''
      await sent
    },
  }
}

export const readRedisLog = (redis: Redis, key: string, count: number) => redis.lrange(key, -count, -1)

export const removeLeftoverLogs = () => rm(LOGS_DIR, { recursive: true, force: true })
