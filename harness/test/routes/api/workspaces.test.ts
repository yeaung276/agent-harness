import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'
import { strToU8, zipSync } from 'fflate'

import { loadConfig } from '../../../src/config.ts'
import { users, workspaces } from '../../../src/db/schema.ts'
import { createPlacementService } from '../../../src/services/placement/index.ts'
import { decrypt } from '../../../src/services/workspaces/crypto.ts'
import { buildTestApp } from '../../test-app.ts'

const dir = await mkdtemp(join(tmpdir(), 'workspaces-'))
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
const email = `${crypto.randomUUID()}@example.com`

type Sent = { worker: string; path: string; body: Record<string, unknown> }
let sent: Sent[] = []
let answer: (() => Response) | null = null

// the worker's internal API, as the server reaches it over mTLS
app.decorate('workers', {
  call: async (worker: string, path: string, init: RequestInit) => {
    sent.push({ worker, path, body: JSON.parse(String(init.body)) })
    return answer ? answer() : new Response(null, { status: 204 })
  },
} as never)

// worker-0 is live, and claims workspaces through its own placement
const placement = createPlacementService({
  redis: app.redis,
  workerName: 'worker-0',
  sandboxIdleMs: 15 * 60 * 1000,
  browserIdleMs: 5 * 60 * 1000,
  minFreeMemoryMb: 300,
})

beforeEach(async () => {
  sent = []
  answer = null
  await app.redis.hset('pods:worker-0', {
    hostname: 'worker-0',
    address: '10.0.0.1:3000',
    bootId: placement.bootId,
    reportedAt: Date.now(),
    sandboxes: 0,
    sandboxSlots: 50,
    sessions: 0,
  })
})

const [user] = await app.db
  .insert(users)
  .values({ email, passwordHash: await Bun.password.hash('secret-password', 'argon2id') })
  .returning({ id: users.id })
const token = await app.services.tokens.create(user!.id, { name: 'ci', expiresInDays: null })

afterAll(async () => {
  await app.close()
  await rm(dir, { recursive: true })
  await rm(depsDir, { recursive: true })
})

const headers = { authorization: `Bearer ${token}` }
const uniqueName = () => `ws-${crypto.randomUUID().slice(0, 8)}`

const createWorkspace = (name: string, defaultEnv?: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name, defaultEnv } })

const getWorkspace = (id: string) => app.inject({ url: `/api/v1/workspaces/${id}`, headers })

const updateWorkspace = (
  id: string,
  payload: { defaultEnv?: Record<string, string | null>; network?: { allow?: string[]; deny?: string[] } }
) => app.inject({ method: 'PATCH', url: `/api/v1/workspaces/${id}`, headers, payload })

const storedEnv = async (id: string) => {
  const [row] = await app.db.select({ defaultEnv: workspaces.defaultEnv }).from(workspaces).where(eq(workspaces.id, id))
  return row!.defaultEnv
}

const deleteWorkspace = (id: string) => app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${id}`, headers })

const upload = (id: string, zip: Uint8Array, path?: string) => {
  const payload = new FormData()
  payload.append('file', new File([zip as Uint8Array<ArrayBuffer>], 'site.zip'))
  if (path !== undefined) payload.append('path', path)
  return app.inject({ method: 'PUT', url: `/api/v1/workspaces/${id}/upload`, headers, payload })
}

const waitFor = async (file: string) => {
  for (let i = 0; i < 100 && !existsSync(file); i++) await Bun.sleep(10)
  return readFile(file, 'utf8')
}

describe('workspaces on the API', () => {
  test('I can create a workspace and get it back', async () => {
    const name = uniqueName()

    const created = await createWorkspace(name)
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ name, status: 'stopped', createdBy: { id: user!.id, email } })

    const res = await getWorkspace(created.json().id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(created.json())
  })

  test('a new workspace gets an empty folder', async () => {
    const { id } = (await createWorkspace(uniqueName())).json()

    expect(await readdir(join(dir, id))).toEqual([])
  })

  test('a name can only be used once', async () => {
    const name = uniqueName()
    await createWorkspace(name)

    const res = await createWorkspace(name)

    expect(res.statusCode).toBe(409)
    expect(res.json().message).toBe('A workspace already has this name')
  })

  test('a name with capitals or spaces is refused', async () => {
    expect((await createWorkspace('My App')).statusCode).toBe(400)
  })

  test('an unknown workspace is not found', async () => {
    const res = await getWorkspace(crypto.randomUUID())

    expect(res.statusCode).toBe(404)
    expect(res.json().message).toBe('Workspace not found')
  })

  test('deleting a workspace removes it, its files and its installed deps', async () => {
    const { id } = (await createWorkspace(uniqueName())).json()
    await writeFile(join(dir, id, 'index.html'), '<h1>hi</h1>')
    await mkdir(join(depsDir, id, 'node_modules', 'react'), { recursive: true })

    const res = await deleteWorkspace(id)

    expect(res.statusCode).toBe(204)
    expect((await getWorkspace(id)).statusCode).toBe(404)
    expect(existsSync(join(dir, id))).toBe(false)
    for (let i = 0; i < 100 && existsSync(join(depsDir, id)); i++) await Bun.sleep(10)
    expect(existsSync(join(depsDir, id))).toBe(false)
  })

  test('deleting a running workspace stops its app on its worker first', async () => {
    const { id } = (await createWorkspace(uniqueName())).json()
    await placement.claimWorkspace(id)

    const res = await deleteWorkspace(id)

    expect(res.statusCode).toBe(204)
    expect(sent).toEqual([{ worker: 'worker-0', path: '/internal/sandbox/stop', body: { workspaceId: id } }])
    expect((await getWorkspace(id)).statusCode).toBe(404)
  })

  test('deleting a running workspace whose worker answers an error keeps it', async () => {
    const { id } = (await createWorkspace(uniqueName())).json()
    await placement.claimWorkspace(id)
    answer = () => Response.json({ message: 'boom' }, { status: 500 })

    const res = await deleteWorkspace(id)

    expect(res.statusCode).toBe(500)
    expect((await getWorkspace(id)).statusCode).toBe(200)
  })

  test('deleting a workspace with nothing running calls no worker', async () => {
    const { id } = (await createWorkspace(uniqueName())).json()

    await deleteWorkspace(id)

    expect(sent).toEqual([])
  })

  test('deleting an unknown workspace is not found', async () => {
    expect((await deleteWorkspace(crypto.randomUUID())).statusCode).toBe(404)
  })

  test('creating without a token is refused', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/workspaces', payload: { name: uniqueName() } })

    expect(res.statusCode).toBe(401)
  })

  test('the default env is stored encrypted and never returned', async () => {
    const created = await createWorkspace(uniqueName(), { API_KEY: 'secret-value' })
    expect(created.statusCode).toBe(201)
    expect(created.json()).not.toHaveProperty('defaultEnv')
    expect(created.json().defaultEnvKeys).toEqual(['API_KEY'])

    const stored = await storedEnv(created.json().id)
    expect(stored.API_KEY).not.toBe('secret-value')
    expect(decrypt(app.config.DATA_ENCRYPTION_KEY, stored.API_KEY!)).toBe('secret-value')
  })

  test('I can set and remove default env values', async () => {
    const { id } = (await createWorkspace(uniqueName(), { KEEP: 'a', REMOVE: 'b' })).json()

    const res = await updateWorkspace(id, { defaultEnv: { REMOVE: null, ADD: 'c' } })

    expect(res.statusCode).toBe(204)
    const stored = await storedEnv(id)
    expect(Object.keys(stored).sort()).toEqual(['ADD', 'KEEP'])
    expect((await getWorkspace(id)).json().defaultEnvKeys).toEqual(['ADD', 'KEEP'])
    expect(decrypt(app.config.DATA_ENCRYPTION_KEY, stored.KEEP!)).toBe('a')
    expect(decrypt(app.config.DATA_ENCRYPTION_KEY, stored.ADD!)).toBe('c')
  })

  test('I can set the network rules when creating, and replace them without touching the default env', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers,
      payload: {
        name: uniqueName(),
        defaultEnv: { KEEP: 'a' },
        network: { deny: ['*'], allow: ['registry.npmjs.org'] },
      },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().network).toEqual({ deny: ['*'], allow: ['registry.npmjs.org'] })

    const res = await updateWorkspace(created.json().id, {
      network: { allow: ['appx-apps-db.promptxv3.svc.cluster.local'] },
    })

    expect(res.statusCode).toBe(204)
    expect((await getWorkspace(created.json().id)).json()).toMatchObject({
      network: { allow: ['appx-apps-db.promptxv3.svc.cluster.local'] },
      defaultEnvKeys: ['KEEP'],
    })
  })

  test('a workspace created without network rules has none', async () => {
    expect((await createWorkspace(uniqueName())).json().network).toEqual({})
  })

  test('updating an unknown workspace is not found', async () => {
    expect((await updateWorkspace(crypto.randomUUID(), { defaultEnv: {} })).statusCode).toBe(404)
  })
})

describe('uploading a zip to a workspace', () => {
  const site = zipSync({ 'index.html': strToU8('<h1>hi</h1>'), 'assets/app.js': strToU8('let a = 1') })

  test('the files land in the workspace root', async () => {
    const { id } = (await createWorkspace(uniqueName())).json()

    const res = await upload(id, site)

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ path: '', files: 2 })
    expect(await waitFor(join(dir, id, 'index.html'))).toBe('<h1>hi</h1>')
    expect(await waitFor(join(dir, id, 'assets/app.js'))).toBe('let a = 1')
  })

  test('the files land in the folder I name', async () => {
    const { id } = (await createWorkspace(uniqueName())).json()

    const res = await upload(id, site, 'site')

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ path: 'site', files: 2 })
    expect(await waitFor(join(dir, id, 'site/index.html'))).toBe('<h1>hi</h1>')
  })

  test('a path out of the workspace is refused', async () => {
    const { id } = (await createWorkspace(uniqueName())).json()

    expect((await upload(id, site, '../escape')).statusCode).toBe(400)
  })

  test('a zip with an entry leading out of the folder is refused, and nothing is extracted', async () => {
    const { id } = (await createWorkspace(uniqueName())).json()

    const res = await upload(id, zipSync({ 'ok.txt': strToU8('ok'), '../evil.txt': strToU8('evil') }))

    expect(res.statusCode).toBe(400)
    expect(await readdir(join(dir, id))).toEqual([])
  })

  test('a zip with a link is refused', async () => {
    const { id } = (await createWorkspace(uniqueName())).json()

    const res = await upload(id, zipSync({ link: [strToU8('/etc/passwd'), { attrs: 0o120777 * 2 ** 16 }] }))

    expect(res.statusCode).toBe(400)
  })

  test('a file that is not a zip is refused', async () => {
    const { id } = (await createWorkspace(uniqueName())).json()

    expect((await upload(id, strToU8('not a zip'))).statusCode).toBe(400)
  })

  test('uploading to an unknown workspace is not found', async () => {
    expect((await upload(crypto.randomUUID(), site)).statusCode).toBe(404)
  })
})
