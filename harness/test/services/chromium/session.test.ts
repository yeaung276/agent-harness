import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Browser, Page } from 'playwright-core'

import { type Chromium, createChromium } from '../../../src/services/chromium/chromium.ts'
import { createSession, type SessionState } from '../../../src/services/chromium/session.ts'
import { setupCgroups } from '../../../src/services/sandbox/sandbox.ts'

const linux = process.env.CONTAINER_TEST === '1'
const mode = linux ? 'bwrap' : 'none'

const WORKSPACE_PORT = 4110
const OTHER_WORKSPACE_PORT = 4111
const POD_SERVICE_PORT = 4300
const BLANK: SessionState = { url: null, storageState: null }

const servers: ReturnType<typeof Bun.serve>[] = []
let chromium: Chromium
let connection: Browser

const app = (port: number, name: string) =>
  servers.push(
    Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch: (request, server) => {
        if (server.upgrade(request, { data: undefined })) return
        const headers = new Headers({ 'content-type': 'text/html' })
        if (new URL(request.url).pathname === '/login') headers.set('set-cookie', 'session=abc; Path=/')
        return new Response(`<title>${name}</title><p>cookie=${request.headers.get('cookie') ?? ''}</p>`, { headers })
      },
      websocket: {
        open: ws => {
          ws.send('hello')
        },
        message: () => {},
      },
    })
  )

const opened = (options: Partial<Parameters<typeof createSession>[1]> = {}) =>
  createSession(connection, { record: false, getWorkspaceAccessPort: () => WORKSPACE_PORT, ...BLANK, ...options })

const pageOf = async (targetId: string) => {
  for (const context of connection.contexts()) {
    for (const page of context.pages()) {
      const cdp = await context.newCDPSession(page)
      const { targetInfo } = await cdp.send('Target.getTargetInfo')
      await cdp.detach()
      if (targetInfo.targetId === targetId) return page
    }
  }
  throw new Error(`no page ${targetId}`)
}

const visit = (page: Page, url: string) =>
  page.goto(url, { timeout: 5000 }).then(
    response => response?.status() ?? 'no response',
    () => 'blocked'
  )

const greeting = (page: Page, url: string) =>
  page.evaluate(
    url =>
      new Promise<string>(resolve => {
        const ws = new WebSocket(url)
        ws.onmessage = event => resolve(String(event.data))
        ws.onerror = () => resolve('blocked')
        ws.onclose = () => resolve('blocked')
        setTimeout(() => resolve('timeout'), 3000)
      }),
    url
  )

beforeAll(async () => {
  if (!linux) return
  await setupCgroups(mode)
  app(WORKSPACE_PORT, 'workspace A')
  app(OTHER_WORKSPACE_PORT, 'workspace B')
  app(POD_SERVICE_PORT, 'pod service')

  chromium = createChromium({ mode, portMin: 4100, portMax: 4149 })
  await chromium.start()
  connection = await chromium.connect()
}, 60_000)

afterAll(async () => {
  await chromium?.stop()
  for (const server of servers) server.stop(true)
})

describe.if(linux)('a session', () => {
  test('opens on a blank page, with nothing to save yet', async () => {
    const session = await opened()

    expect(session.isOpen()).toBe(true)
    expect(session.targetId).toEqual(expect.any(String))
    expect(await session.state()).toEqual({ url: null, storageState: { cookies: [], origins: [] } })
  }, 60_000)

  test('saves where its page is and its cookies, after another CDP client moved it', async () => {
    const session = await opened()

    await (await pageOf(session.targetId)).goto(`http://127.0.0.1:${WORKSPACE_PORT}/login`)

    const state = await session.state()
    expect(state.url).toBe(`http://127.0.0.1:${WORKSPACE_PORT}/login`)
    expect(state.storageState).toMatchObject({ cookies: [expect.objectContaining({ name: 'session', value: 'abc' })] })
  }, 60_000)

  test('reopens where it left off, still signed in', async () => {
    const first = await opened()
    await (await pageOf(first.targetId)).goto(`http://127.0.0.1:${WORKSPACE_PORT}/login`)
    const saved = await first.state()
    await first.close()

    const again = await opened({ url: `http://127.0.0.1:${WORKSPACE_PORT}/`, storageState: saved.storageState })
    const page = await pageOf(again.targetId)

    expect(page.url()).toBe(`http://127.0.0.1:${WORKSPACE_PORT}/`)
    expect(await page.textContent('p')).toBe('cookie=session=abc')
  }, 60_000)

  test("reaches its own workspace's port and public sites, and not another workspace's port or the pod", async () => {
    const page = await pageOf((await opened()).targetId)

    expect(await visit(page, `http://127.0.0.1:${WORKSPACE_PORT}/`)).toBe(200)
    expect(await visit(page, 'https://registry.npmjs.org/')).toBe(200)
    expect(await visit(page, `http://127.0.0.1:${OTHER_WORKSPACE_PORT}/`)).toBe('blocked')
    expect(await visit(page, `http://127.0.0.1:${POD_SERVICE_PORT}/`)).toBe('blocked')
  }, 60_000)

  test('without a workspace, reaches public sites and no port on the pod', async () => {
    const page = await pageOf((await opened({ getWorkspaceAccessPort: undefined })).targetId)

    expect(await visit(page, 'https://registry.npmjs.org/')).toBe(200)
    expect(await visit(page, `http://127.0.0.1:${WORKSPACE_PORT}/`)).toBe('blocked')
    expect(await visit(page, `http://127.0.0.1:${OTHER_WORKSPACE_PORT}/`)).toBe('blocked')
  }, 60_000)

  test('holds the rule for requests the page makes itself, WebSockets included', async () => {
    const page = await pageOf((await opened()).targetId)
    await page.goto(`http://127.0.0.1:${WORKSPACE_PORT}/`)

    const fetched = (url: string) => page.evaluate(url => fetch(url).then(r => r.status, () => 'blocked'), url)

    expect(await fetched(`http://127.0.0.1:${OTHER_WORKSPACE_PORT}/`)).toBe('blocked')
    expect(await greeting(page, `ws://127.0.0.1:${WORKSPACE_PORT}/`)).toBe('hello')
    expect(await greeting(page, `ws://127.0.0.1:${OTHER_WORKSPACE_PORT}/`)).toBe('blocked')
  }, 60_000)

  test("follows its workspace onto a new port", async () => {
    let port = WORKSPACE_PORT
    const page = await pageOf((await opened({ getWorkspaceAccessPort: () => port })).targetId)

    port = OTHER_WORKSPACE_PORT

    expect(await visit(page, `http://127.0.0.1:${OTHER_WORKSPACE_PORT}/`)).toBe(200)
    expect(await visit(page, `http://127.0.0.1:${WORKSPACE_PORT}/`)).toBe('blocked')
  }, 60_000)

  test('knows when something else closed its page', async () => {
    const session = await opened()

    await (await pageOf(session.targetId)).close()

    expect(session.isOpen()).toBe(false)
  }, 60_000)

  test('counts each use once, however often it is released', async () => {
    const session = await opened()

    const release = session.use()
    const other = session.use()
    release()
    release()
    expect(session.isIdle(-1)).toBe(false)

    other()
    expect(session.isIdle(-1)).toBe(true)
  }, 60_000)

  test('closes its context, and closing again is harmless', async () => {
    const before = connection.contexts().length
    const session = await opened()

    await session.close()
    await session.close()

    expect(session.isOpen()).toBe(false)
    expect(connection.contexts()).toHaveLength(before)
  }, 60_000)
})

describe.if(linux)('recording', () => {
  const recordings = () => readdir(join(tmpdir(), 'chromium-recordings')).catch(() => [])

  test('exports the whole video of a recorded session once closed, and keeps no copy of its own', async () => {
    const out = await mkdtemp(join(tmpdir(), 'export-'))
    const session = await opened({ record: true })
    await visit(await pageOf(session.targetId), `http://127.0.0.1:${WORKSPACE_PORT}/`)

    await session.close()
    await session.exportRecording(join(out, 'browser', 'session.webm'))

    const video = await readFile(join(out, 'browser', 'session.webm'))
    expect(video.length).toBeGreaterThan(1000)
    expect([...video.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3])
    expect(await recordings()).toEqual([])
  }, 60_000)

  test('exports nothing for a session that was not recorded', async () => {
    const out = await mkdtemp(join(tmpdir(), 'export-'))
    const session = await opened()

    await session.close()
    await session.exportRecording(join(out, 'session.webm'))

    expect(await readdir(out)).toEqual([])
  }, 60_000)
})
