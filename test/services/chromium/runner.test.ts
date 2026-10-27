import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Browser, BrowserContext } from 'playwright-core'

import { type Chromium, createChromium } from '../../../src/services/chromium/chromium.ts'
import {
  type NavigatedContent,
  ops,
  type PageContent,
  type PageRef,
} from '../../../src/services/chromium/ops.ts'
import { createRunner, type Runner } from '../../../src/services/chromium/runner.ts'
import { setupCgroups } from '../../../src/services/sandbox/sandbox.ts'

const linux = process.env.CONTAINER_TEST === '1'
const mode = linux ? 'bwrap' : 'none'

const LAUNCH = 'http://127.0.0.1:4100/'

const servers: ReturnType<typeof Bun.serve>[] = []
const contexts: BrowserContext[] = []
let chromium: Chromium
let connection: Browser
let runner: Runner

const serve = (hostname: string, port: number, body: string) =>
  servers.push(Bun.serve({ hostname, port, fetch: () => new Response(body) }))

const until = async <T>(probe: () => Promise<T>, done: (value: T) => boolean) => {
  const deadline = Date.now() + 15_000
  let value = await probe()
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(100)
    value = await probe()
  }
  return value
}

const sessionPage = async () => {
  const context = await connection.newContext()
  contexts.push(context)
  const page = await context.newPage()

  const cdp = await context.newCDPSession(page)
  const { targetInfo } = await cdp.send('Target.getTargetInfo')
  await cdp.detach()

  return { page, targetId: targetInfo.targetId }
}

beforeAll(async () => {
  if (!linux) return
  await setupCgroups(mode)
  serve('127.0.0.1', 4100, 'app')

  chromium = createChromium({ mode, portMin: 4100, portMax: 4149 })
  await chromium.start()
  connection = await chromium.connect()
  runner = createRunner({ mode, chromium })
}, 60_000)

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close().catch(() => undefined)
})

afterAll(async () => {
  await chromium?.stop()
  for (const server of servers) server.stop(true)
})

describe.if(linux)('runner', () => {
  test("runs the code on the session's page and returns its result, and the page's owner sees what it did", async () => {
    const { page, targetId } = await sessionPage()

    const ran = await runner.exec(
      targetId,
      `await page.goto('${LAUNCH}'); return { text: await page.textContent('body') }`,
      30_000
    )

    expect(ran).toMatchObject({ result: { text: 'app' }, error: null, timedOut: false })
    expect(page.url()).toBe(LAUNCH)
  }, 60_000)

  test('takes code with quotes, dollar signs and backticks as it is', async () => {
    const { targetId } = await sessionPage()

    const ran = await runner.exec(targetId, "return `it's $HOME ${'`'} \"quoted\"`", 30_000)

    expect(ran).toMatchObject({ result: 'it\'s $HOME ` "quoted"', error: null })
  }, 60_000)

  test("hands back the code's own error instead of failing", async () => {
    const { targetId } = await sessionPage()

    const ran = await runner.exec(targetId, `throw new Error('boom')`, 30_000)

    expect(ran).toMatchObject({ result: null, error: 'boom', timedOut: false })
  }, 60_000)

  test('keeps what the code prints out of the result', async () => {
    const { targetId } = await sessionPage()

    const ran = await runner.exec(
      targetId,
      `console.log('noise'); process.stdout.write('more noise\\n'); return 42`,
      30_000
    )

    expect(ran).toMatchObject({ result: 42, error: null })
  }, 60_000)

  test("says so when the result can't travel as JSON", async () => {
    const { targetId } = await sessionPage()

    const ran = await runner.exec(targetId, `const a = {}; a.self = a; return a`, 30_000)

    expect(ran.result).toBeNull()
    expect(ran.error).toMatch(/not JSON/)
  }, 60_000)

  test('stops code that runs past its time, and the page takes the next call', async () => {
    const { targetId } = await sessionPage()

    const ran = await runner.exec(targetId, `await new Promise(() => {})`, 2000)

    expect(ran).toMatchObject({ result: null, timedOut: true, error: 'timed out after 2 s' })
    expect(ran.durationMs).toBeLessThan(10_000)

    const next = await runner.exec(targetId, `return 1`, 30_000)
    expect(next).toMatchObject({ result: 1, error: null })
  }, 60_000)

  test("says page_not_found for a page that isn't there", async () => {
    const ran = await runner.exec('no-such-target', `return 1`, 30_000)

    expect(ran).toMatchObject({ result: null, error: 'page_not_found' })
  }, 60_000)

  test("gives the code none of the runner's environment", async () => {
    process.env.APP_DB_SECRET = 'top-secret'
    const { targetId } = await sessionPage()

    const ran = await runner.exec(targetId, `return process.env`, 30_000)

    expect(ran.result).not.toHaveProperty('APP_DB_SECRET')
    expect(ran.result).not.toHaveProperty('DATABASE_URL')
  }, 60_000)
})

describe.if(linux)('ops', () => {
  const APP_PORT = 4101
  const APP = `http://127.0.0.1:${APP_PORT}`

  const PAGES: Record<string, string> = {
    '/': `<title>Shop</title>
      <h1>Welcome to the shop</h1>
      <a href="/orders">Orders</a>
      <button>Buy</button>
      <form action="/search"><input name="q" placeholder="Search"></form>
      <input type="password" name="pw" value="hunter2" aria-label="Password">
      <input type="hidden" name="token" value="t">
      <a href="/secret" style="display:none">Hidden</a>`,
    '/orders': `<title>Orders</title><p>No orders yet</p><a href="/">Home</a>`,
    '/long': `<title>Long</title><div style="height:3000px">${'word '.repeat(5000)}</div>`,
    '/late': `<title>Late</title>
      <a href="#">Orders</a>
      <script>setTimeout(() => {
        document.querySelector('a').href = '/orders'
        document.body.insertAdjacentHTML('beforeend', '<p id="late">Loaded</p>')
      }, 3000)</script>`,
  }

  const session = async () => {
    const { page, targetId } = await sessionPage()

    const op = async <T>(code: string) => {
      const ran = await runner.exec(targetId, code, 30_000)
      return { result: ran.result as T, error: ran.error }
    }

    return { page, op }
  }

  const named = (refs: PageRef[], name: string) => {
    const ref = refs.find(r => r.name === name)
    if (!ref) throw new Error(`no ref named ${name} in ${JSON.stringify(refs.map(r => r.name))}`)
    return ref
  }

  beforeAll(() => {
    servers.push(
      Bun.serve({
        hostname: '127.0.0.1',
        port: APP_PORT,
        fetch: request => {
          const url = new URL(request.url)
          const body =
            url.pathname === '/search'
              ? `<title>Search</title><p>Results for ${url.searchParams.get('q')}</p>`
              : PAGES[url.pathname]
          return new Response(body ?? '<title>Not found</title>', {
            status: body === undefined ? 404 : 200,
            headers: { 'content-type': 'text/html' },
          })
        },
      })
    )
  })

  test("navigate opens a path on the workspace's port and returns the page", async () => {
    const { op } = await session()

    const { result } = await op<NavigatedContent>(ops.navigate('/', APP_PORT))

    expect(result).toMatchObject({ title: 'Shop', url: `${APP}/`, status: 200, error: null })
    expect(result.text).toContain('Welcome to the shop')
    expect(named(result.refs, 'Orders').href).toBe(`${APP}/orders`)
  }, 60_000)

  test("navigate to a path says workspace_not_running when the workspace isn't up, and stays put", async () => {
    const { page, op } = await session()

    const { result } = await op<NavigatedContent>(ops.navigate('/orders', null))

    expect(result).toMatchObject({ status: null, error: 'workspace_not_running' })
    expect(page.url()).toBe('about:blank')
  }, 60_000)

  test('navigate reports an address that answers nothing in its response, not as a failed call', async () => {
    const { op } = await session()

    const ran = await op<NavigatedContent>(ops.navigate('http://127.0.0.1:4149/', APP_PORT))

    expect(ran.error).toBeNull()
    expect(ran.result.status).toBeNull()
    expect(ran.result.error).toMatch(/net::ERR_/)
  }, 60_000)

  test("navigate gives a missing page's status", async () => {
    const { op } = await session()

    const { result } = await op<NavigatedContent>(ops.navigate('/nope', APP_PORT))

    expect(result).toMatchObject({ title: 'Not found', status: 404, error: null })
  }, 60_000)

  test("read lists what can be acted on, skips what can't be seen, and never returns a password", async () => {
    const { op } = await session()
    await op(ops.navigate('/', APP_PORT))

    const { result } = await op<PageContent>(ops.read())

    expect(result.refs.map(r => r.name)).toEqual(['Orders', 'Buy', 'q', 'Password'])
    expect(result.refs.map(r => r.ref)).toEqual([1, 2, 3, 4])
    expect(named(result.refs, 'q').placeholder).toBe('Search')
    expect(named(result.refs, 'Password').value).toBe('')
  }, 60_000)

  test('read cuts the text at maxChars', async () => {
    const { op } = await session()
    await op(ops.navigate('/long', APP_PORT))

    const { result } = await op<PageContent>(ops.read(100))

    expect(result.text).toHaveLength(100)
  }, 60_000)

  test('click follows a link and returns the new page, numbered afresh', async () => {
    const { op } = await session()
    const home = await op<NavigatedContent>(ops.navigate('/', APP_PORT))

    const { result } = await op<PageContent>(ops.click(named(home.result.refs, 'Orders').ref))

    expect(result).toMatchObject({ title: 'Orders', url: `${APP}/orders` })
    expect(result.refs).toEqual([expect.objectContaining({ ref: 1, name: 'Home' })])
  }, 60_000)

  test('click says ref_not_found for a ref not on the page, including one from a page left behind', async () => {
    const { op } = await session()
    const home = await op<NavigatedContent>(ops.navigate('/', APP_PORT))
    await op(ops.click(named(home.result.refs, 'Orders').ref))

    expect(await op(ops.click(99))).toMatchObject({ result: null, error: 'ref_not_found' })
    expect(await op(ops.click(named(home.result.refs, 'Buy').ref))).toMatchObject({ error: 'ref_not_found' })
  }, 60_000)

  test('type fills a field, and submits its form only when asked', async () => {
    const { op } = await session()
    const home = await op<NavigatedContent>(ops.navigate('/', APP_PORT))
    const search = named(home.result.refs, 'q').ref

    const filled = await op<PageContent>(ops.type(search, 'boots', false))
    expect(filled.result.title).toBe('Shop')
    expect(named(filled.result.refs, 'q').value).toBe('boots')

    const submitted = await op<PageContent>(ops.type(search, 'boots', true))
    expect(submitted.result).toMatchObject({ title: 'Search', url: `${APP}/search?q=boots` })
    expect(submitted.result.text).toContain('Results for boots')
  }, 60_000)

  test('type and navigate take any text as data, not as code', async () => {
    const { op } = await session()
    const home = await op<NavigatedContent>(ops.navigate('/', APP_PORT))
    const text = 'a\'b"c`${process.exit(1)}`\\n)}); throw 1; //'

    const { result } = await op<PageContent>(ops.type(named(home.result.refs, 'q').ref, text, false))
    expect(named(result.refs, 'q').value).toBe(text)

    const odd = await op<NavigatedContent>(ops.navigate("/orders?x=');process.exit(1);('", APP_PORT))
    expect(odd.result).toMatchObject({ title: 'Orders', status: 200 })
  }, 60_000)

  test('screenshot returns a PNG, of the whole page when asked', async () => {
    const { op } = await session()
    await op(ops.navigate('/long', APP_PORT))

    const height = (png: string) => Buffer.from(png, 'base64').readUInt32BE(20)
    const view = await op<{ png: string }>(ops.screenshot(false))
    const full = await op<{ png: string }>(ops.screenshot(true))

    expect(Buffer.from(view.result.png, 'base64').subarray(1, 4).toString()).toBe('PNG')
    expect(height(full.result.png)).toBeGreaterThan(height(view.result.png))
  }, 60_000)

  test("arbitrary runs the caller's code as it is", async () => {
    const { op } = await session()
    await op(ops.navigate('/', APP_PORT))

    const { result } = await op<string[]>(ops.arbitrary(`return await page.$$eval('a', as => as.map(a => a.textContent))`))

    expect(result).toEqual(['Orders', 'Hidden'])
  }, 60_000)

  test('navigate waits after the load until the page shows what until names', async () => {
    const { op } = await session()

    const { result } = await op<NavigatedContent>(ops.navigate('/late', APP_PORT, { selector: '#late', text: 'Loaded' }))

    expect(result).toMatchObject({ title: 'Late', status: 200, error: null })
    expect(result.text).toContain('Loaded')
  }, 60_000)

  test('navigate whose until runs out says so, on the page it landed on', async () => {
    const { page, op } = await session()

    const ran = await op<NavigatedContent>(ops.navigate('/late', APP_PORT, { selector: '#never', timeoutMs: 1000 }))

    expect(ran.error).toBeNull()
    expect(ran.result).toMatchObject({ title: 'Late', status: 200, error: 'waitFor timed out' })
    expect(page.url()).toBe(`${APP}/late`)
  }, 60_000)

  test('read waits for waitFor before it reads', async () => {
    const { op } = await session()
    await op(ops.navigate('/late', APP_PORT))

    const early = await op<PageContent>(ops.read())
    const { result } = await op<PageContent>(ops.read(undefined, { text: 'Loaded' }))

    expect(early.result.text).not.toContain('Loaded')
    expect(result.text).toContain('Loaded')
  }, 60_000)

  test('click waits for waitFor before it clicks', async () => {
    const { op } = await session()
    const late = await op<NavigatedContent>(ops.navigate('/late', APP_PORT))

    const { result } = await op<PageContent>(ops.click(named(late.result.refs, 'Orders').ref, { selector: '#late' }))

    expect(result).toMatchObject({ title: 'Orders', url: `${APP}/orders` })
  }, 60_000)

  test('click, type and screenshot whose waitFor runs out say wait_for_timed_out and do nothing', async () => {
    const { page, op } = await session()
    const home = await op<NavigatedContent>(ops.navigate('/', APP_PORT))
    const never = { selector: '#never', timeoutMs: 1000 }

    expect(await op(ops.click(named(home.result.refs, 'Orders').ref, never))).toMatchObject({
      result: null,
      error: 'wait_for_timed_out',
    })
    expect(await op(ops.type(named(home.result.refs, 'q').ref, 'boots', true, never))).toMatchObject({
      result: null,
      error: 'wait_for_timed_out',
    })
    expect(await op(ops.screenshot(false, never))).toMatchObject({ result: null, error: 'wait_for_timed_out' })
    expect(page.url()).toBe(`${APP}/`)
    expect(await page.locator('input[name="q"]').inputValue()).toBe('')
  }, 60_000)
})

describe.if(linux)('a confined runner', () => {
  const clusterIp = process.env.TEST_DB_HOST ?? ''

  const runCgroups = async () => (await readdir('/sys/fs/cgroup')).filter(name => name.startsWith('workspace-run-'))

  test("can't see the server's files", async () => {
    const { targetId } = await sessionPage()

    const ran = await runner.exec(
      targetId,
      `return process.getBuiltinModule('fs').existsSync('${join(process.cwd(), 'package.json')}')`,
      30_000
    )

    expect(ran).toMatchObject({ result: false, error: null })
  }, 60_000)

  test("can't change the playwright-core it is given", async () => {
    const { targetId } = await sessionPage()

    const ran = await runner.exec(
      targetId,
      `process.getBuiltinModule('fs').writeFileSync('/workspace/node_modules/playwright-core/tampered', 'x')`,
      30_000
    )

    expect(ran.error).toMatch(/read-only|EROFS/i)
  }, 60_000)

  test('reaches Chromium, and nothing else on the pod or the cluster', async () => {
    serve('127.0.0.1', 4002, 'internal api')
    serve(clusterIp, 5744, 'cluster service')
    const { targetId } = await sessionPage()

    const ran = await runner.exec(
      targetId,
      `const reach = url => fetch(url, { signal: AbortSignal.timeout(3000) }).then(r => (r.ok ? r.status : 'blocked'), () => 'blocked')
       return {
         internalApi: await reach('http://127.0.0.1:4002/'),
         launch: await reach('${LAUNCH}'),
         cluster: await reach('http://${clusterIp}:5744/'),
         metadata: await reach('http://169.254.169.254/'),
         internet: await reach('https://registry.npmjs.org/'),
       }`,
      30_000
    )

    expect(ran.result).toEqual({
      internalApi: 'blocked',
      launch: 'blocked',
      cluster: 'blocked',
      metadata: 'blocked',
      internet: 'blocked',
    })
  }, 60_000)

  test('runs in a cgroup of its own, under its limits, gone once the call returns', async () => {
    const { targetId } = await sessionPage()

    const ran = runner.exec(targetId, `await new Promise(r => setTimeout(r, 3000)); return 1`, 30_000)

    const [cgroup] = await until(runCgroups, names => names.length > 0)
    const read = (file: string) => readFile(join('/sys/fs/cgroup', cgroup!, file), 'utf8')
    expect((await read('memory.max')).trim()).toBe(String(512 * 1024 * 1024))
    expect((await read('pids.max')).trim()).toBe('128')

    expect(await ran).toMatchObject({ result: 1 })
    expect(await until(runCgroups, names => names.length === 0)).toEqual([])
  }, 60_000)
})
