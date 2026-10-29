import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Redis } from 'ioredis'

const LOGS_DIR = join(tmpdir(), 'sandbox-logs')
const COPY_MS = 1000
const REDIS_MAX_LINES = 1000
const REDIS_TTL_SECONDS = 24 * 60 * 60

export const createLog = () => {
  mkdirSync(LOGS_DIR, { recursive: true })
  const path = join(LOGS_DIR, `${randomUUID()}.log`)
  const fd = openSync(path, 'a')
  let removed = false

  return {
    fd,

    write: (text: string) => {
      if (!removed) writeSync(fd, text)
    },

    tail: async (count: number, clean = false) => {
      if (removed) return []

      const file = Bun.file(path)
      const text = await file.slice(Math.max(0, file.size - 1024 * 1024)).text()
      return (clean ? text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '') : text)
        .split('\n')
        .filter(line => !clean || line.trim())
        .slice(-count)
    },

    remove: async () => {
      if (removed) return
      removed = true
      closeSync(fd)
      await rm(path, { force: true })
    },
  }
}

export const createRedisLog = (redis: Redis, key: string) => {
  const log = createLog()
  let copied = ''
  let copying = Promise.resolve()
  let removed = false

  const copy = async () => {
    const text = (await log.tail(REDIS_MAX_LINES, true)).join('\n')
    if (text === copied) return
    await redis.set(key, text, 'EX', REDIS_TTL_SECONDS)
    copied = text
  }

  void redis.del(key).catch(() => {})
  const timer = setInterval(() => {
    copying = copying.then(copy).catch(() => {})
  }, COPY_MS)

  return {
    fd: log.fd,

    write: log.write,

    tail: async (count: number, clean = false) => (removed ? readRedisLog(redis, key, count) : log.tail(count, clean)),

    remove: async () => {
      if (removed) return
      removed = true
      clearInterval(timer)
      await copying
      await copy().catch(() => {})
      await log.remove()
    },
  }
}

export const readRedisLog = async (redis: Redis, key: string, count: number) =>
  ((await redis.get(key)) ?? '').split('\n').filter(Boolean).slice(-count)

export const removeLeftoverLogs = () => rm(LOGS_DIR, { recursive: true, force: true })
