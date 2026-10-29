import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../../../src/config.ts'
import { users } from '../../../src/db/schema.ts'
import { proxy } from '../../../src/plugins/proxy.ts'
import { createPlacementService } from '../../../src/services/placement/index.ts'
import { buildTestApp } from '../../test-app.ts'

const dir = await mkdtemp(join(tmpdir(), 'sandbox-api-'))
const depsDir = await mkdtemp(join(tmpdir(), 'deps-'))
const app = await buildTestApp(
  loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WORKSPACES_DIR: dir,
    SANDBOX_DEPS_ROOT: depsDir,
  })
)

type Sent = { worker: string; path: string; body: Record<string, unknown> }
let sent: Sent[] = []
let answer: ((call: Sent) => Response | Promise<Response>) | null = null

const answers: Record<string, () => Response> = {
  '/internal/sandbox/launch': () => new Response(null, { status: 204 }),
  '/internal/sandbox/exec': () => Response.json({ exitCode: 0, output: 'ok', timedOut: false }),
  '/internal/sandbox/stop': () => new Response(null, { status: 204 }),
  '/internal/sandbox/logs': () => Response.json({ lines: ['listening on 3000'] }),
}

// the worker's internal API, as the server reaches it over mTLS
app.decorate('workers', {
  call: async (worker: string, path: string, init: RequestInit) => {
    const call = { worker, path, body: JSON.parse(String(init.body)) }
    sent.push(call)
    return answer ? answer(call) : answers[path]!()
  },
} as never)
await app.register(proxy)

const [user] = await app.db
  .insert(users)
  .values({ email: `${crypto.randomUUID()}@example.com`, passwordHash: await Bun.password.hash('secret-password') })
  .returning({ id: users.id })
const token = await app.services.tokens.create(user!.id, { name: 'ci', expiresInDays: null })
const headers = { authorization: `Bearer ${token}` }

afterAll(async () => {
  await app.close()
  await rm(dir, { recursive: true })
  await rm(depsDir, { recursive: true })
})

// a worker whose stats reporter writes pods:<name>, and whose sandbox manager claims through placement
const startWorker = async (name: string, sandboxes: number) => {
  const placement = createPlacementService({
    redis: app.redis,
    workerName: name,
    sandboxIdleMs: 15 * 60 * 1000,
    browserIdleMs: 5 * 60 * 1000,
  })
  await app.redis.hset(`pods:${name}`, {
    hostname: name,
    address: `10.0.0.${sandboxes}:3000`,
    bootId: placement.bootId,
    reportedAt: Date.now(),
    sandboxes,
    sandboxSlots: 50,
    sessions: 0,
  })
  return placement
}

const newWorkspace = async () =>
  (await app.services.workspaces.create(user!.id, `ws-${crypto.randomUUID().slice(0, 8)}`)).id

const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, headers, payload })

let busy: Awaited<ReturnType<typeof startWorker>>
let id: string

beforeEach(async () => {
  sent = []
  answer = null
  await app.redis.flushall()
  // worker-0 is the busier one, so following a placement and picking by load differ
  busy = await startWorker('worker-0', 30)
  await startWorker('worker-1', 5)
  id = await newWorkspace()
})

describe('launch', () => {
  test('goes to the most free worker with the workspace in the body, and answers the URL', async () => {
    const res = await post(`/api/v1/workspaces/${id}/sandbox/launch`, { command: 'npm run dev', port: 3000 })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ url: `http://${id}.localhost:3001/` })
    expect(sent).toEqual([
      {
        worker: 'worker-1',
        path: '/internal/sandbox/launch',
        body: { command: 'npm run dev', port: 3000, workspaceId: id },
      },
    ])
  })

  test('is a 409 while the workspace runs, and calls no worker', async () => {
    await busy.claimWorkspace(id)

    const res = await post(`/api/v1/workspaces/${id}/sandbox/launch`, { command: 'npm run dev', port: 3000 })

    expect(res.statusCode).toBe(409)
    expect(res.json().message).toBe('A background process is already running')
    expect(sent).toEqual([])
  })

  test('is a 404 for an unknown workspace, and calls no worker', async () => {
    const res = await post(`/api/v1/workspaces/${crypto.randomUUID()}/sandbox/launch`, { command: 'x', port: 3000 })

    expect(res.statusCode).toBe(404)
    expect(sent).toEqual([])
  })

  test('is a 503 when no worker reports', async () => {
    await app.redis.flushall()

    const res = await post(`/api/v1/workspaces/${id}/sandbox/launch`, { command: 'npm run dev', port: 3000 })

    expect(res.statusCode).toBe(503)
    expect(sent).toEqual([])
  })

  test("answers the worker's refusal with its status and message", async () => {
    answer = () => Response.json({ message: 'No free port on this worker' }, { status: 503 })

    const res = await post(`/api/v1/workspaces/${id}/sandbox/launch`, { command: 'npm run dev', port: 3000 })

    expect(res.statusCode).toBe(503)
    expect(res.json().message).toBe('No free port on this worker')
  })

  test("is a 503 when the worker can't be reached", async () => {
    answer = () => {
      throw new TypeError('connect ECONNREFUSED')
    }

    const res = await post(`/api/v1/workspaces/${id}/sandbox/launch`, { command: 'npm run dev', port: 3000 })

    expect(res.statusCode).toBe(503)
    expect(res.json().message).toBe("worker worker-1 can't be reached")
  })

  test('is refused without a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${id}/sandbox/launch`,
      payload: { command: 'npm run dev', port: 3000 },
    })

    expect(res.statusCode).toBe(401)
  })
})

describe('exec', () => {
  test('with nothing running goes to the most free worker, and answers its result', async () => {
    const res = await post(`/api/v1/workspaces/${id}/sandbox/exec`, { command: 'ls' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ exitCode: 0, output: 'ok', timedOut: false })
    expect(sent).toEqual([
      {
        worker: 'worker-1',
        path: '/internal/sandbox/exec',
        body: { command: 'ls', timeoutMs: 120_000, workspaceId: id },
      },
    ])
  })

  test('while the workspace runs goes to its worker', async () => {
    await busy.claimWorkspace(id)

    await post(`/api/v1/workspaces/${id}/sandbox/exec`, { command: 'ls' })

    expect(sent.map(call => call.worker)).toEqual(['worker-0'])
  })
})

describe('logs', () => {
  test('while the workspace runs come from its worker, with the tail asked for', async () => {
    await busy.claimWorkspace(id)

    const res = await app.inject({ url: `/api/v1/workspaces/${id}/sandbox/logs?tail=50`, headers })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ lines: ['listening on 3000'] })
    expect(sent).toEqual([{ worker: 'worker-0', path: '/internal/sandbox/logs', body: { workspaceId: id, tail: 50 } }])
  })

  test('are a 409 with nothing running, and call no worker', async () => {
    const res = await app.inject({ url: `/api/v1/workspaces/${id}/sandbox/logs`, headers })

    expect(res.statusCode).toBe(409)
    expect(res.json().message).toBe('Nothing is running in this workspace')
    expect(sent).toEqual([])
  })
})

describe('stop', () => {
  test('while the workspace runs goes to its worker', async () => {
    await busy.claimWorkspace(id)

    const res = await post(`/api/v1/workspaces/${id}/sandbox/stop`)

    expect(res.statusCode).toBe(204)
    expect(sent).toEqual([{ worker: 'worker-0', path: '/internal/sandbox/stop', body: { workspaceId: id } }])
  })

  test('with nothing running clears the saved launch and records stopped itself, so a request cannot wake it', async () => {
    await app.services.workspaces.setLaunchOptions(id, { command: 'npm run dev', port: 3000, env: {}, network: {} })
    await app.services.workspaces.setStatus(id, 'running')

    const res = await post(`/api/v1/workspaces/${id}/sandbox/stop`)

    expect(res.statusCode).toBe(204)
    expect(sent).toEqual([])
    expect(await app.services.workspaces.getLaunchOptions(id)).toBeNull()
    expect((await app.services.workspaces.get(id)).status).toBe('stopped')
  })

  test('is a 404 for an unknown workspace', async () => {
    const res = await post(`/api/v1/workspaces/${crypto.randomUUID()}/sandbox/stop`)

    expect(res.statusCode).toBe(404)
  })
})
