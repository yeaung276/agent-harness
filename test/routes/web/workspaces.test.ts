import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { eq } from 'drizzle-orm'
import { strToU8, zipSync } from 'fflate'

import { loadConfig } from '../../../src/config.ts'
import { users, workspaces } from '../../../src/db/schema.ts'
import { decrypt } from '../../../src/services/workspaces/crypto.ts'
import { buildTestApp } from '../../test-app.ts'

const dir = await mkdtemp(join(tmpdir(), 'workspaces-'))
const app = await buildTestApp(
  loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', WORKSPACES_DIR: dir })
)

afterAll(async () => {
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
  const res = await app.inject({
    method: 'POST',
    url: '/login',
    headers: form,
    payload: new URLSearchParams({ email, password: 'secret-password' }).toString(),
  })
  return { email, cookies: { sid: res.cookies.find(cookie => cookie.name === 'sid')!.value } }
}

const createWorkspace = (
  cookies: { sid: string },
  name: string,
  zip?: Uint8Array,
  defaultEnv?: Record<string, string>
) => {
  const payload = new FormData()
  payload.append('name', name)
  if (zip) payload.append('file', new File([zip as Uint8Array<ArrayBuffer>], 'site.zip'))
  if (defaultEnv) payload.append('defaultEnv', JSON.stringify(defaultEnv))
  return app.inject({ method: 'POST', url: '/workspaces', cookies, payload })
}

const storedEnv = async (name: string) => {
  const [row] = await app.db
    .select({ defaultEnv: workspaces.defaultEnv })
    .from(workspaces)
    .where(eq(workspaces.name, name))
  return Object.fromEntries(
    Object.entries(row!.defaultEnv).map(([key, value]) => [key, decrypt(app.config.DATA_ENCRYPTION_KEY, value)])
  )
}

const uniqueName = () => `ws-${crypto.randomUUID().slice(0, 8)}`

const workspaceWithFiles = async (cookies: { sid: string }, files: Record<string, string>) => {
  const name = uniqueName()
  await createWorkspace(cookies, name)
  const [row] = await app.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.name, name))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, row!.id, path)), { recursive: true })
    await writeFile(join(dir, row!.id, path), content)
  }
  return { id: row!.id, name }
}

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

  test('a workspace created with environment variables stores them', async () => {
    const { cookies } = await signIn()
    const name = uniqueName()

    const res = await createWorkspace(cookies, name, undefined, { API_KEY: 'secret-value' })

    expect(res.statusCode).toBe(302)
    expect(await storedEnv(name)).toEqual({ API_KEY: 'secret-value' })
  })

  test('editing adds, replaces and removes environment variables, and keeps the rest', async () => {
    const { cookies } = await signIn()
    const name = uniqueName()
    await createWorkspace(cookies, name, undefined, { KEEP: 'a', REPLACE: 'b', REMOVE: 'x' })
    const [row] = await app.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.name, name))

    const res = await app.inject({
      method: 'POST',
      url: `/workspaces/${row!.id}/env`,
      cookies,
      headers: form,
      payload: new URLSearchParams({ defaultEnv: JSON.stringify({ REPLACE: 'c', ADD: 'd', REMOVE: null }) }).toString(),
    })

    expect(res.statusCode).toBe(302)
    expect(await storedEnv(name)).toEqual({ KEEP: 'a', REPLACE: 'c', ADD: 'd' })
  })
})

describe('workspace page', () => {
  test('a workspace in the list links to its page', async () => {
    const { cookies } = await signIn()
    const { id, name } = await workspaceWithFiles(cookies, {})

    const list = await app.inject({ url: '/workspaces', cookies })
    expect(list.body).toContain(`href="/workspaces/${id}"`)

    const page = await app.inject({ url: `/workspaces/${id}`, cookies })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain(name)
  })

  test('the tree lists one folder at a time, folders first', async () => {
    const { cookies } = await signIn()
    const { id } = await workspaceWithFiles(cookies, {
      'index.html': '<h1>hi</h1>',
      'src/app.ts': 'export {}',
      'src/lib/util.ts': '',
    })

    const root = await app.inject({ url: `/workspaces/${id}/tree`, cookies })
    expect(root.json()).toMatchObject([
      { name: 'src', path: 'src/', type: 'directory' },
      { name: 'index.html', path: 'index.html', type: 'file', size: 11 },
    ])

    const src = await app.inject({ url: `/workspaces/${id}/tree?path=src`, cookies })
    expect(src.json()).toMatchObject([
      { name: 'lib', path: 'src/lib/', type: 'directory' },
      { name: 'app.ts', path: 'src/app.ts', type: 'file' },
    ])
  })

  test('the tree leaves out ignored folders and .env files, but shows .env.example', async () => {
    const { cookies } = await signIn()
    const { id } = await workspaceWithFiles(cookies, {
      'index.html': '',
      '.env': 'SECRET=1',
      '.env.local': 'SECRET=2',
      '.env.example': 'SECRET=',
      'node_modules/pkg/index.js': '',
      '.git/HEAD': '',
    })

    const res = await app.inject({ url: `/workspaces/${id}/tree`, cookies })

    expect(res.json().map((entry: { path: string }) => entry.path)).toEqual(['.env.example', 'index.html'])
  })

  test('a file comes back as it is, sandboxed', async () => {
    const { cookies } = await signIn()
    const { id } = await workspaceWithFiles(cookies, { 'src/app.ts': 'export {}' })

    const res = await app.inject({ url: `/workspaces/${id}/files/src/app.ts`, cookies })

    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('export {}')
    expect(res.headers['content-security-policy']).toBe('sandbox')
  })

  test('nothing outside the workspace can be listed or read, even through a link', async () => {
    const { cookies } = await signIn()
    const { id } = await workspaceWithFiles(cookies, {})
    await writeFile(join(dir, 'secret.txt'), 'secret')
    await symlink(join(dir, 'secret.txt'), join(dir, id, 'secret.txt'))

    const up = await app.inject({ url: `/workspaces/${id}/tree?path=..`, cookies })
    const link = await app.inject({ url: `/workspaces/${id}/files/secret.txt`, cookies })

    expect(up.statusCode).toBe(404)
    expect(link.statusCode).toBe(404)
  })
})
