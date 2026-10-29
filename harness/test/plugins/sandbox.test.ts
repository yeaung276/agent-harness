import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

import { loadConfig } from '../../src/config.ts'
import { users, workspaces } from '../../src/db/schema.ts'
import { sandbox } from '../../src/plugins/sandbox.ts'
import { readRedisLog } from '../../src/services/sandbox/log.ts'
import { buildTestApp } from '../test-app.ts'

const SERVER =
  `bun -e "Bun.serve({ port: Number(process.env.PORT), ` +
  `fetch: (req, server) => server.upgrade(req) ? undefined : new Response('app ' + new URL(req.url).pathname), ` +
  `websocket: { message: (ws, message) => ws.send('echo ' + message) } })"`

const root = await mkdtemp(join(tmpdir(), 'sandbox-plugin-'))

const config = (env: Record<string, string> = {}) =>
  loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WORKSPACES_DIR: join(root, 'workspaces'),
    SANDBOX_DEPS_ROOT: join(root, 'deps'),
    ...env,
  })

const startWorker = async () => {
  const app = await buildTestApp(config({ APP_MODE: 'worker' }))
  await app.listen({ host: '127.0.0.1', port: 0 })
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`

  const [user] = await app.db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@example.com`, passwordHash: 'x' })
    .returning({ id: users.id })

  const post = (path: string, body: object) =>
    fetch(`${base}/internal/sandbox${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const launched = async (command = SERVER) => {
    const { id } = await app.services.workspaces.create(user!.id, `ws-${crypto.randomUUID().slice(0, 8)}`)
    expect((await post('/launch', { workspaceId: id, command, port: 3000 })).status).toBe(204)
    return id
  }

  return { app, base, post, launched }
}

afterAll(() => rm(root, { recursive: true, force: true }))

describe('the sandbox plugin', () => {
  test('refuses to start unless APP_MODE is worker', async () => {
    const app = await buildTestApp(config())

    app.register(sandbox)

    await expect(app.ready()).rejects.toThrow("the sandbox plugin runs only with APP_MODE=worker (got 'server')")
    await app.close().catch(() => {})
  })
})

describe('a worker', () => {
  let worker: Awaited<ReturnType<typeof startWorker>>

  beforeAll(async () => {
    worker = await startWorker()
  })

  afterAll(() => worker.app.close())

  test('runs launch, exec and stop through the internal API', async () => {
    const { app, post, launched } = worker
    const workspaceId = await launched()

    const exec = await post('/exec', { workspaceId, command: 'echo hi' })
    expect(exec.status).toBe(200)
    expect(await exec.json()).toEqual({ exitCode: 0, output: 'hi\n', timedOut: false })

    expect((await post('/stop', { workspaceId })).status).toBe(204)
    const [row] = await app.db
      .select({ status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
    expect(row!.status).toBe('stopped')
  })

  test("puts a launch's log in Redis under launch-logs:<workspaceId>, ending with how it ended", async () => {
    const { app, launched } = worker
    const id = await launched('echo "Error: Cannot find module express"; exit 1')

    const deadline = Date.now() + 10_000
    while ((await readRedisLog(app.redis, `launch-logs:${id}`, 10)).at(-1) !== 'exited with code 1') {
      if (Date.now() > deadline) throw new Error('timed out waiting for the launch log')
      await Bun.sleep(100)
    }
    expect(await readRedisLog(app.redis, `launch-logs:${id}`, 10)).toEqual([
      'Error: Cannot find module express',
      'exited with code 1',
    ])
  })

  test('refuses an internal call with a bad body', async () => {
    expect((await worker.post('/launch', { command: SERVER, port: 3000 })).status).toBe(400)
    expect((await worker.post('/exec', { workspaceId: 'not-a-uuid', command: 'ls' })).status).toBe(400)
  })

  test('sends a request marked x-workspace-app to the workspace whatever its path, and the rest to the internal API', async () => {
    const { base, post, launched } = worker
    const workspaceId = await launched()

    const marked = await fetch(`${base}/internal/sandbox/exec`, { headers: { 'x-workspace-app': workspaceId } })
    const unmarked = await post('/exec', { workspaceId, command: 'true' })

    expect(await marked.text()).toBe('app /internal/sandbox/exec')
    expect(unmarked.headers.get('content-type')).toContain('application/json')
  })

  test('forwards a WebSocket marked x-workspace-app and refuses one without it', async () => {
    const { base, launched } = worker
    const workspaceId = await launched()
    const url = `${base.replace('http', 'ws')}/live`

    const marked = new WebSocket(url, { headers: { 'x-workspace-app': workspaceId } })
    await new Promise(resolve => (marked.onopen = resolve))
    const echoed = new Promise(resolve => (marked.onmessage = event => resolve(event.data)))
    marked.send('ping')
    expect(await echoed).toBe('echo ping')
    marked.close()

    const unmarked = new WebSocket(url)
    const outcome = await new Promise(resolve => {
      unmarked.onopen = () => resolve('open')
      unmarked.onerror = () => resolve('refused')
    })
    expect(outcome).toBe('refused')
  })
})

describe('closing a worker', () => {
  test('stops every launch while the database is still there to record it', async () => {
    const { app, base, launched } = await startWorker()
    const workspaceId = await launched()
    await fetch(base, { headers: { 'x-workspace-app': workspaceId } })
    const { hostPort } = (await app.sandbox.wake(workspaceId))!

    await app.close()

    expect(
      await fetch(`http://127.0.0.1:${hostPort}/`).then(
        () => 'answered',
        () => 'gone'
      )
    ).toBe('gone')
  })
})
