import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq, inArray } from 'drizzle-orm'
import { strToU8, zipSync } from 'fflate'

import { buildApp } from '../../../src/app.ts'
import { loadConfig } from '../../../src/config.ts'
import { users, workspaces } from '../../../src/db/schema.ts'

const dir = await mkdtemp(join(tmpdir(), 'workspaces-'))
const app = await buildApp(
  loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', WORKSPACES_DIR: dir })
)
const userIds: string[] = []

afterAll(async () => {
  await app.db.delete(workspaces).where(inArray(workspaces.userId, userIds))
  await app.db.delete(users).where(inArray(users.id, userIds))
  await app.close()
  await rm(dir, { recursive: true })
})

const form = { 'content-type': 'application/x-www-form-urlencoded' }

// a new user, logged in
const signIn = async () => {
  const email = `${crypto.randomUUID()}@example.com`
  const [user] = await app.db
    .insert(users)
    .values({ email, passwordHash: await Bun.password.hash('secret-password', 'argon2id') })
    .returning({ id: users.id })
  userIds.push(user!.id)
  const res = await app.inject({
    method: 'POST',
    url: '/login',
    headers: form,
    payload: new URLSearchParams({ email, password: 'secret-password' }).toString(),
  })
  return { email, cookies: { sid: res.cookies.find(cookie => cookie.name === 'sid')!.value } }
}

const createWorkspace = (cookies: { sid: string }, name: string, zip?: Uint8Array) => {
  const payload = new FormData()
  payload.append('name', name)
  if (zip) payload.append('file', new File([zip as Uint8Array<ArrayBuffer>], 'site.zip'))
  return app.inject({ method: 'POST', url: '/workspaces', cookies, payload })
}

const uniqueName = () => `ws-${crypto.randomUUID().slice(0, 8)}`

describe('workspaces page', () => {
  test('a workspace created on the page shows up for everyone, with who created it', async () => {
    const alice = await signIn()
    const bob = await signIn()
    const name = uniqueName()

    const res = await createWorkspace(alice.cookies, name)
    expect(res.statusCode).toBe(302)

    const list = await app.inject({ url: '/workspaces', cookies: bob.cookies })
    expect(list.body).toContain(name)
    expect(list.body).toContain(alice.email)
  })

  test("anyone can delete anyone's workspace, and its folder goes", async () => {
    const alice = await signIn()
    const bob = await signIn()
    const name = uniqueName()
    await createWorkspace(alice.cookies, name)
    const [row] = await app.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.name, name))

    const res = await app.inject({ method: 'POST', url: `/workspaces/${row!.id}/delete`, cookies: bob.cookies })
    expect(res.statusCode).toBe(302)

    const list = await app.inject({ url: '/workspaces', cookies: bob.cookies })
    expect(list.body).not.toContain(name)
    expect(existsSync(join(dir, row!.id))).toBe(false)
  })

  test('deleting a workspace that is already gone just reloads the list', async () => {
    const { cookies } = await signIn()

    const res = await app.inject({ method: 'POST', url: `/workspaces/${crypto.randomUUID()}/delete`, cookies })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/workspaces')
  })

  test('a taken name is shown as an error', async () => {
    const { cookies } = await signIn()
    const name = uniqueName()
    await createWorkspace(cookies, name)

    const res = await createWorkspace(cookies, name)

    expect(res.statusCode).toBe(409)
    expect(res.body).toContain('A workspace already has this name')
  })

  test('a workspace created with a zip has its files', async () => {
    const { cookies } = await signIn()
    const name = uniqueName()

    const res = await createWorkspace(cookies, name, zipSync({ 'index.html': strToU8('<h1>hi</h1>') }))
    expect(res.statusCode).toBe(302)

    const [row] = await app.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.name, name))
    const file = join(dir, row!.id, 'index.html')
    for (let i = 0; i < 100 && !existsSync(file); i++) await Bun.sleep(10)
    expect(await readFile(file, 'utf8')).toBe('<h1>hi</h1>')
  })

  test('a bad name is shown as an error, and kept in the box to fix', async () => {
    const { cookies } = await signIn()

    const res = await createWorkspace(cookies, 'My App')

    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('Use 1–63 lowercase letters')
    expect(res.body).toContain('value="My App"')
  })
})
