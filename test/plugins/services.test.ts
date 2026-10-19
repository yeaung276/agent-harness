import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'

const dir = await mkdtemp(join(tmpdir(), 'workspaces-'))
const app = await buildApp(
  loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', WORKSPACES_DIR: dir })
)

afterAll(async () => {
  await app.close()
  await rm(dir, { recursive: true })
})

describe('starting the app', () => {
  test('removes files a delete left behind', async () => {
    const leftover = join(dir, '.deleted', crypto.randomUUID())
    await mkdir(leftover, { recursive: true })
    await writeFile(join(leftover, 'index.html'), '<h1>hi</h1>')

    await app.ready()
    // the removal runs in the background
    for (let i = 0; i < 100 && existsSync(leftover); i++) await Bun.sleep(10)

    expect(existsSync(leftover)).toBe(false)
  })
})
