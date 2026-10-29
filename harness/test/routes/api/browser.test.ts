import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../../../src/config.ts'
import { users } from '../../../src/db/schema.ts'
import { createPlacementService } from '../../../src/services/placement/index.ts'
import { buildTestApp } from '../../test-app.ts'

const dir = await mkdtemp(join(tmpdir(), 'browser-api-'))
const app = await buildTestApp(
  loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', WORKSPACES_DIR: dir })
)

type Sent = { worker: string; path: string; body: Record<string, unknown> }
let sent: Sent[] = []
let answer: ((call: Sent) => Response | Promise<Response>) | null = null

const page = { title: 'Orders', url: 'http://127.0.0.1:4100/orders', text: 'Orders', refs: [] }

const answers: Record<string, (call: Sent) => Response | Promise<Response>> = {
  // the worker inserts the row, as the chromium manager does
  '/internal/chromium/session': async ({ body }) =>
    Response.json(
      await app.services.browsers.create(String(body.userId), {
        workspaceId: (body.workspaceId as string | undefined) ?? null,
        record: Boolean(body.record),
      }),
      { status: 201 }
    ),
  '/internal/chromium/read': () => Response.json(page),
  '/internal/chromium/screenshot': () => Response.json({ path: 'screenshot/shot.png' }, { status: 201 }),
  '/internal/chromium/close': () => new Response(null, { status: 204 }),
}

// the worker's internal API, as the server reaches it over mTLS
app.decorate('workers', {
  call: async (worker: string, path: string, init: RequestInit) => {
    const call = { worker, path, body: JSON.parse(String(init.body)) }
    sent.push(call)
    return answer ? answer(call) : answers[path]!(call)
  },
} as never)

const email = `${crypto.randomUUID()}@example.com`
const [user] = await app.db
  .insert(users)
  .values({ email, passwordHash: await Bun.password.hash('secret-password') })
  .returning({ id: users.id })
const token = await app.services.tokens.create(user!.id, { name: 'ci', expiresInDays: null })
const headers = { authorization: `Bearer ${token}` }

afterAll(async () => {
  await app.close()
  await rm(dir, { recursive: true })
})

// a worker whose stats reporter writes pods:<name>, and whose managers claim through placement
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

const post = (url: string, payload: object = {}) => app.inject({ method: 'POST', url, headers, payload })

const openSession = async (workspaceId?: string) => {
  const res = await post('/api/v1/browser', { workspaceId })
  sent = []
  return res.json().id as string
}

let busy: Awaited<ReturnType<typeof startWorker>>
let workspaceId: string

beforeEach(async () => {
  sent = []
  answer = null
  await app.redis.flushall()
  // worker-0 is the busier one, so following a placement and picking by load differ
  busy = await startWorker('worker-0', 30)
  await startWorker('worker-1', 5)
  workspaceId = (await app.services.workspaces.create(user!.id, `ws-${crypto.randomUUID().slice(0, 8)}`)).id
})

describe('opening a session', () => {
  test('without a workspace goes to the most free worker, and answers the session with who created it', async () => {
    const res = await post('/api/v1/browser')

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      workspaceId: null,
      record: false,
      status: 'alive',
      createdBy: { id: user!.id, email },
    })
    expect(res.json().userId).toBeUndefined()
    expect(sent).toEqual([
      { worker: 'worker-1', path: '/internal/chromium/session', body: { record: false, userId: user!.id } },
    ])
  })

  test("for a running workspace goes to the workspace's worker", async () => {
    await busy.claimWorkspace(workspaceId)

    await post('/api/v1/browser', { workspaceId, record: true })

    expect(sent).toEqual([
      { worker: 'worker-0', path: '/internal/chromium/session', body: { workspaceId, record: true, userId: user!.id } },
    ])
  })

  test('for a workspace with nothing running goes to the most free worker', async () => {
    await post('/api/v1/browser', { workspaceId })

    expect(sent.map(call => call.worker)).toEqual(['worker-1'])
  })

  test('record without a workspace is a 400, and calls no worker', async () => {
    const res = await post('/api/v1/browser', { record: true })

    expect(res.statusCode).toBe(400)
    expect(sent).toEqual([])
  })

  test('an unknown workspace is a 404, and calls no worker', async () => {
    const res = await post('/api/v1/browser', { workspaceId: crypto.randomUUID() })

    expect(res.statusCode).toBe(404)
    expect(sent).toEqual([])
  })

  test('is a 503 when no worker reports', async () => {
    await app.redis.flushall()

    const res = await post('/api/v1/browser')

    expect(res.statusCode).toBe(503)
  })
})

describe('a call on a session', () => {
  test('goes to the worker holding its tab, with the session in the body', async () => {
    const id = await openSession()
    await busy.claimSession(id)

    const res = await post(`/api/v1/browser/${id}/read`, { maxChars: 100 })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(page)
    expect(sent).toEqual([
      { worker: 'worker-0', path: '/internal/chromium/read', body: { maxChars: 100, sessionId: id } },
    ])
  })

  test("once its tab is gone, goes to its running workspace's worker", async () => {
    const id = await openSession(workspaceId)
    await busy.claimWorkspace(workspaceId)

    await post(`/api/v1/browser/${id}/read`)

    expect(sent.map(call => call.worker)).toEqual(['worker-0'])
  })

  test('once its tab is gone, without a running workspace goes to the most free worker', async () => {
    const id = await openSession()

    await post(`/api/v1/browser/${id}/read`)

    expect(sent.map(call => call.worker)).toEqual(['worker-1'])
  })

  test('on an unknown session is a 404, and calls no worker', async () => {
    const res = await post(`/api/v1/browser/${crypto.randomUUID()}/read`)

    expect(res.statusCode).toBe(404)
    expect(sent).toEqual([])
  })

  test("answers the worker's refusal with its status and message", async () => {
    const id = await openSession()
    answer = () => Response.json({ message: 'No element on the page has this ref' }, { status: 404 })

    const res = await post(`/api/v1/browser/${id}/click`, { ref: 7 })

    expect(res.statusCode).toBe(404)
    expect(res.json().message).toBe('No element on the page has this ref')
  })

  test('a screenshot answers 201 with its path', async () => {
    const id = await openSession(workspaceId)

    const res = await post(`/api/v1/browser/${id}/screenshot`)

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ path: 'screenshot/shot.png' })
  })

  test('closing goes to the worker holding its tab, and answers 204', async () => {
    const id = await openSession()
    await busy.claimSession(id)

    const res = await app.inject({ method: 'DELETE', url: `/api/v1/browser/${id}`, headers })

    expect(res.statusCode).toBe(204)
    expect(sent).toEqual([{ worker: 'worker-0', path: '/internal/chromium/close', body: { sessionId: id } }])
  })
})
