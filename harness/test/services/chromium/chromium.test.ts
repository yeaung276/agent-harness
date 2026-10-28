import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { Page } from 'playwright-core'

import { CDP_PORT, type Chromium, createChromium } from '../../../src/services/chromium/chromium.ts'
import { setupCgroups } from '../../../src/services/sandbox/sandbox.ts'

const linux = process.env.CONTAINER_TEST === '1'
const mode = linux ? 'bwrap' : 'none'

const LAUNCH = 'http://127.0.0.1:4100/'
const CGROUP = '/sys/fs/cgroup/workspace-chromium'

const servers: ReturnType<typeof Bun.serve>[] = []
let browser: Chromium | undefined

const serve = (hostname: string, port: number, body: string) => {
  const server = Bun.serve({ hostname, port, fetch: () => new Response(body) })
  servers.push(server)
  return server
}

const cdpAnswers = () =>
  fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1000) }).then(
    response => response.ok,
    () => false
  )

const until = async <T>(probe: () => Promise<T>, done: (value: T) => boolean) => {
  const deadline = Date.now() + 15_000
  let value = await probe()
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(200)
    value = await probe()
  }
  return value
}

const started = async () => {
  browser = createChromium({ mode, portMin: 4100, portMax: 4149 })
  await browser.start()
  return browser
}

const visit = (page: Page, url: string) =>
  page.goto(url, { timeout: 5000 }).then(
    response => (response?.ok() ? response.status() : 'blocked'),
    () => 'blocked'
  )

const profiles = async () => (await readdir(tmpdir())).filter(name => name.startsWith('chromium-'))

beforeAll(async () => {
  if (!linux) return
  await setupCgroups(mode)
  serve('127.0.0.1', 4100, 'app')
})

afterEach(async () => {
  await browser?.stop()
  browser = undefined
})

afterAll(() => {
  for (const server of servers) server.stop(true)
})

describe.if(linux)('chromium', () => {
  test("opens pages on the workspace launches on the pod's localhost", async () => {
    const page = await (await (await started()).connect()).newPage()

    await page.goto(LAUNCH)

    expect(await page.textContent('body')).toBe('app')
  }, 60_000)

  test('lets another CDP client drive one of its pages, and keeps its own connection when that client leaves', async () => {
    const own = await started()
    const connection = await own.connect()
    const context = await connection.newContext()
    const page = await context.newPage()

    const cdp = await context.newCDPSession(page)
    const { targetInfo } = await cdp.send('Target.getTargetInfo')
    await cdp.detach()

    const runner = `
      const { chromium } = require('playwright-core')
      ;(async () => {
        const browser = await chromium.connectOverCDP('${own.connectionUrl()}')
        for (const context of browser.contexts()) {
          for (const page of context.pages()) {
            const cdp = await context.newCDPSession(page)
            const { targetInfo } = await cdp.send('Target.getTargetInfo')
            await cdp.detach()
            if (targetInfo.targetId === '${targetInfo.targetId}') await page.goto('${LAUNCH}')
          }
        }
        process.exit(0)
      })()
    `
    await promisify(execFile)(process.execPath, ['-e', runner], { cwd: process.cwd(), timeout: 30_000 })

    expect(page.url()).toBe(LAUNCH)
    expect(await page.textContent('body')).toBe('app')

    const another = await connection.newPage()
    await another.goto(LAUNCH)
    expect(await another.textContent('body')).toBe('app')
  }, 60_000)

  test('tells its owner when Chromium dies on its own, and starts again', async () => {
    const own = await started()
    let exits = 0
    own.onExit(() => exits++)

    const cdp = await (await own.connect()).newBrowserCDPSession()
    await cdp.send('Browser.close').catch(() => undefined)

    expect(await until(async () => exits, count => count > 0)).toBe(1)
    expect(() => own.connectionUrl()).toThrow(/not running/)

    await own.start()
    const page = await (await own.connect()).newPage()
    await page.goto(LAUNCH)

    expect(await page.textContent('body')).toBe('app')
    expect(exits).toBe(1)
  }, 60_000)

  test('stops without reporting a crash, and leaves nothing answering and no profile behind', async () => {
    const before = await profiles()
    const own = await started()
    let exits = 0
    own.onExit(() => exits++)

    await own.stop()

    expect(await until(cdpAnswers, answers => !answers)).toBe(false)
    expect(() => own.connectionUrl()).toThrow(/not running/)
    expect(exits).toBe(0)
    expect(await profiles()).toEqual(before)
  }, 60_000)

})

describe.if(linux)('a confined chromium', () => {
  const clusterIp = process.env.TEST_DB_HOST ?? ''

  const cgroupExists = () => access(CGROUP).then(
    () => true,
    () => false
  )

  test("says why when the pod's CDP port is taken, and leaves nothing running", async () => {
    const squatter = serve('127.0.0.1', CDP_PORT, 'not chromium')

    browser = createChromium({ mode, portMin: 4100, portMax: 4149 })
    await expect(browser.start()).rejects.toThrow(/chromium did not start/)
    expect(() => browser!.connectionUrl()).toThrow(/not running/)
    expect(await until(cgroupExists, exists => !exists)).toBe(false)

    squatter.stop(true)
  }, 60_000)

  test('reaches the internet and the workspace launches, and nothing else on the pod or the cluster, even without the network rule', async () => {
    serve('127.0.0.1', 4002, 'internal api')
    serve('127.0.0.1', 4200, 'other service')
    serve(clusterIp, 5644, 'cluster service')

    const page = await (await (await started()).connect()).newPage()

    expect(await visit(page, 'https://registry.npmjs.org/')).toBe(200)
    expect(await visit(page, LAUNCH)).toBe(200)
    expect(await visit(page, 'http://127.0.0.1:4002/')).toBe('blocked')
    expect(await visit(page, 'http://127.0.0.1:4200/')).toBe('blocked')
    expect(await visit(page, `http://${clusterIp}:5644/`)).toBe('blocked')
    expect(await visit(page, 'http://169.254.169.254/')).toBe('blocked')
  }, 90_000)

  test("can't read the server's files", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'secret-'))
    await writeFile(join(dir, 'secret'), 'x')

    const connection = await (await started()).connect()

    expect(await visit(await connection.newPage(), `file://${join(dir, 'secret')}`)).toBe('blocked')
    expect(await visit(await connection.newPage(), `file://${join(process.cwd(), 'package.json')}`)).toBe('blocked')
  }, 60_000)

  test('runs under its cgroup limits, and the cgroup is gone once stopped', async () => {
    const own = await started()

    expect((await readFile(join(CGROUP, 'cgroup.procs'), 'utf8')).trim()).not.toBe('')
    expect((await readFile(join(CGROUP, 'memory.max'), 'utf8')).trim()).toBe(String(2048 * 1024 * 1024))
    expect((await readFile(join(CGROUP, 'cpu.max'), 'utf8')).trim()).toBe('200000 100000')
    expect((await readFile(join(CGROUP, 'pids.max'), 'utf8')).trim()).toBe('1024')

    await own.stop()

    expect(await until(cgroupExists, exists => !exists)).toBe(false)
  }, 60_000)
})
