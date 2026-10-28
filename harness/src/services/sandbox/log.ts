import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LOGS_DIR = join(tmpdir(), 'sandbox-logs')

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

export const removeLeftoverLogs = () => rm(LOGS_DIR, { recursive: true, force: true })
