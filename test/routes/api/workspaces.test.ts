import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'
import { strToU8, zipSync } from 'fflate'

import { buildApp } from '../../../src/app.ts'
import { loadConfig } from '../../../src/config.ts'
import { users, workspaces } from '../../../src/db/schema.ts'

const dir = await mkdtemp(join(tmpdir(), 'workspaces-'))
const app = await buildApp(
  loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', WORKSPACES_DIR: dir })
)
const email = `${crypto.randomUUID()}@example.com`

const [user] = await app.db
  .insert(users)
  .values({ email, passwordHash: await Bun.password.hash('secret-password', 'argon2id') })
  .returning({ id: users.id })
const token = await app.services.tokens.create(user!.id, { name: 'ci', expiresInDays: null })

afterAll(async () => {
  await app.db.delete(workspaces).where(eq(workspaces.userId, user!.id))
  await app.db.delete(users).where(eq(users.id, user!.id))
  await app.close()
  await rm(dir, { recursive: true })
})

const headers = { authorization: `Bearer ${token}` }
const uniqueName = () => `ws-${crypto.randomUUID().slice(0, 8)}`

const createWorkspace = (name: string) =>
  app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name } })

const getWorkspace = (id: string) => app.inject({ url: `/api/v1/workspaces/${id}`, headers })

const deleteWorkspace = (id: string) => app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${id}`, headers })

const upload = (id: string, zip: Uint8Array, path?: string) => {
  const payload = new FormData()
  payload.append('file', new File([zip as Uint8Array<ArrayBuffer>], 'site.zip'))
  if (path !== undefined) payload.append('path', path)
  return app.inject({ method: 'POST', url: `/api/v1/workspaces/${id}/upload`, headers, payload })
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

  test('deleting a workspace removes it and its files', async () => {
    const { id } = (await createWorkspace(uniqueName())).json()
    await writeFile(join(dir, id, 'index.html'), '<h1>hi</h1>')

    const res = await deleteWorkspace(id)

    expect(res.statusCode).toBe(204)
    expect((await getWorkspace(id)).statusCode).toBe(404)
    expect(existsSync(join(dir, id))).toBe(false)
  })

  test('deleting an unknown workspace is not found', async () => {
    expect((await deleteWorkspace(crypto.randomUUID())).statusCode).toBe(404)
  })

  test('creating without a token is refused', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/workspaces', payload: { name: uniqueName() } })

    expect(res.statusCode).toBe(401)
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
