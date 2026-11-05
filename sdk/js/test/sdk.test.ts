import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Client,
  CodeHarnessError,
  createBrowserUseMiddleware,
  createCodeHarnessMiddleware,
  createSkillUseMiddleware,
  type Sandbox,
} from '../src/index.js'

// runs against a live server and worker, like the Docker Compose stack
const LIVE = Boolean(process.env.CODE_HARNESS_BASE_URL && process.env.CODE_HARNESS_TOKEN)
const SERVER = `require('http').createServer((_, res) => res.end('<h1>hello from the sandbox</h1>')).listen(process.env.PORT)`
const UTF8 = new TextEncoder()

describe.skipIf(!LIVE)('sdk', () => {
  let client: Client
  let sandbox: Sandbox

  beforeAll(async () => {
    client = new Client()
    sandbox = await client.createSandbox({ name: `sdk-test-${Date.now()}`, record: true })
  })

  afterAll(async () => {
    await sandbox?.close()
  })

  test('me answers the token user', async () => {
    expect((await client.me()).email).toContain('@')
  })

  test('getSandbox connects to the same workspace', async () => {
    const again = await client.getSandbox(sandbox.id)
    expect(again.name).toBe(sandbox.name)
  })

  test('getSandbox connects by name too, and throws NOT_FOUND for an unknown one', async () => {
    const again = await client.getSandbox(sandbox.name)
    expect(again.id).toBe(sandbox.id)

    const err = await client.getSandbox(`sdk-missing-${Date.now()}`).catch(e => e)
    expect(err).toBeInstanceOf(CodeHarnessError)
    expect(err.code).toBe('NOT_FOUND')
  })

  test('a bad token throws AUTHENTICATION_FAILED', async () => {
    const bad = new Client({ token: 'pat_nope' })
    const err = await bad.me().catch(e => e)
    expect(err).toBeInstanceOf(CodeHarnessError)
    expect(err.code).toBe('AUTHENTICATION_FAILED')
    expect(err.status).toBe(401)
  })

  test('execute runs from /workspace and returns failures', async () => {
    expect(await sandbox.execute('pwd')).toEqual({ output: '/workspace\n', exitCode: 0, truncated: false })
    expect((await sandbox.execute('exit 3')).exitCode).toBe(3)
  })

  test('deepagents file methods work through the protocol', async () => {
    expect((await sandbox.write('/workspace/src/a.ts', 'const a = 1\n')).error).toBeUndefined()
    expect((await sandbox.edit('/workspace/src/a.ts', 'a = 1', 'a = 2')).error).toBeUndefined()
    expect((await sandbox.readRaw('/workspace/src/a.ts')).data?.content).toBe('const a = 2\n')
    expect((await sandbox.ls('/workspace/src')).files?.map(f => f.path)).toEqual(['/workspace/src/a.ts'])
    expect((await sandbox.glob('**/*.ts', '/workspace')).files?.map(f => f.path)).toContain('src/a.ts')
    expect((await sandbox.grep('a = 2', '/workspace')).matches?.[0]?.line).toBe(1)
  })

  test('file errors come back per path', async () => {
    expect(await sandbox.uploadFiles([['/etc/x', UTF8.encode('x')]])).toEqual([
      { path: '/etc/x', error: 'invalid_path' },
    ])
    expect(await sandbox.uploadFiles([['bin', new Uint8Array([0xff, 0xfe])]])).toEqual([
      { path: 'bin', error: 'invalid_path' },
    ])
    const [missing] = await sandbox.downloadFiles(['/workspace/missing.txt'])
    expect(missing).toEqual({ path: '/workspace/missing.txt', content: null, error: 'file_not_found' })
  })

  test('uploadAsZip extracts into the folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sdk-zip-'))
    try {
      await writeFile(join(dir, 'hello.txt'), 'zipped\n')
      Bun.spawnSync(['zip', '-q', 'site.zip', 'hello.txt'], { cwd: dir })
      const accepted = await sandbox.uploadAsZip(new Uint8Array(await readFile(join(dir, 'site.zip'))), {
        path: '/workspace/site',
      })
      expect(accepted).toEqual({ path: 'site', files: 1 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }

    // extraction finishes after the call answers
    for (let i = 0; i < 20 && (await sandbox.execute('cat site/hello.txt')).exitCode !== 0; i++) await Bun.sleep(250)
    expect((await sandbox.execute('cat site/hello.txt')).output).toBe('zipped\n')
  })

  test('launch, browser and logs', async () => {
    await sandbox.write('/workspace/server.js', SERVER)
    const { url } = await sandbox.launch({ command: 'node server.js', port: 3000 })
    expect(url).toStartWith('http')

    const conflict = await sandbox.launch({ command: 'node server.js', port: 3000 }).catch(e => e)
    expect(conflict.code).toBe('CONFLICT')

    expect(sandbox.browser.id).toBeNull()
    const page = await sandbox.browser.navigate('/')
    expect(page.text).toContain('hello from the sandbox')
    expect(sandbox.browser.id).not.toBeNull()

    const { png, path } = await sandbox.browser.screenshot()
    expect(png.slice(1, 4)).toEqual(UTF8.encode('PNG'))
    const [shot] = await sandbox.downloadFiles([path!])
    expect(shot?.content).toEqual(png)

    await sandbox.stop()
    expect((await sandbox.logs()).at(-1)).toBe('stopped')
  }, 120_000)

  test('middleware tools call the sandbox and hand errors back as text', async () => {
    const middleware = createCodeHarnessMiddleware({ sandbox })
    const tools = new Map(middleware.tools?.map(t => [t.name, t]))
    expect([...tools.keys()]).toEqual([
      'launch_app',
      'app_logs',
      'browser_navigate',
      'browser_read',
      'browser_click',
      'browser_type',
      'browser_screenshot',
    ])

    expect(await tools.get('launch_app')!.invoke({ command: 'node server.js', port: 3000 })).toStartWith('http')
    expect(await tools.get('browser_navigate')!.invoke({ url: '/' })).toContain('hello from the sandbox')
    expect(await tools.get('browser_click')!.invoke({ ref: 999 })).toStartWith('Error: ')
    expect(await tools.get('browser_screenshot')!.invoke({})).toStartWith('/workspace/screenshot/')
    await sandbox.stop()
  }, 120_000)

  test('browser use middleware drives a free browser', async () => {
    const browser = await client.createBrowser()
    const middleware = createBrowserUseMiddleware({ browser })
    const tools = new Map(middleware.tools?.map(t => [t.name, t]))
    expect([...tools.keys()]).toEqual([
      'browser_navigate',
      'browser_read',
      'browser_click',
      'browser_type',
      'browser_screenshot',
    ])

    expect(JSON.parse(await tools.get('browser_read')!.invoke({})).url).toBe('about:blank')
    expect(await tools.get('browser_screenshot')!.invoke({})).toMatchObject([{ type: 'image', mimeType: 'image/png' }])
    await (middleware.afterAgent as () => Promise<void>)()
    expect((await browser.read()).url).toBe('about:blank')
    await browser.close()
  })

  test('skill use middleware lists the skills in the sandbox', async () => {
    await sandbox.write(
      '/workspace/skills/greet/SKILL.md',
      '---\nname: greet\ndescription: Greets someone by name\n---\n\nRun scripts/greet.sh <name>.\n'
    )
    const middleware = createSkillUseMiddleware({ sandbox, sources: ['/workspace/skills/'] })
    const update = await (middleware.beforeModel as (state: object) => Promise<{ skillsMetadata: unknown[] }>)({})
    expect(update.skillsMetadata).toMatchObject([
      { name: 'greet', description: 'Greets someone by name', path: '/workspace/skills/greet/SKILL.md' },
    ])
  })

  test('a free browser reaches public hosts', async () => {
    const browser = await client.createBrowser()
    try {
      expect(browser.sandboxId).toBeNull()
      expect((await client.getBrowser(browser.id!).read()).url).toBe('about:blank')
    } finally {
      await browser.close()
    }
  })
})
