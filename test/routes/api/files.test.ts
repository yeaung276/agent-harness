import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { eq } from 'drizzle-orm'

import { buildApp } from '../../../src/app.ts'
import { loadConfig } from '../../../src/config.ts'
import { users, workspaces } from '../../../src/db/schema.ts'

const dir = await mkdtemp(join(tmpdir(), 'files-'))
const app = await buildApp(
  loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', WORKSPACES_DIR: dir })
)

const [user] = await app.db
  .insert(users)
  .values({
    email: `${crypto.randomUUID()}@example.com`,
    passwordHash: await Bun.password.hash('secret-password', 'argon2id'),
  })
  .returning({ id: users.id })
const token = await app.services.tokens.create(user!.id, { name: 'ci', expiresInDays: null })

afterAll(async () => {
  await app.db.delete(workspaces).where(eq(workspaces.userId, user!.id))
  await app.db.delete(users).where(eq(users.id, user!.id))
  await app.close()
  await rm(dir, { recursive: true })
})

const headers = { authorization: `Bearer ${token}` }

const workspaceWithFiles = async (files: Record<string, string | Uint8Array>) => {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers,
    payload: { name: `ws-${crypto.randomUUID().slice(0, 8)}` },
  })
  const { id } = created.json()
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, id, path)), { recursive: true })
    await writeFile(join(dir, id, path), content)
  }
  return id as string
}

const getTree = (id: string, path = '') =>
  app.inject({ url: `/api/v1/workspaces/${id}/tree?path=${encodeURIComponent(path)}`, headers })

const getFile = (id: string, path: string, query = '') =>
  app.inject({ url: `/api/v1/workspaces/${id}/files/${path}${query}`, headers })

const putFile = (id: string, path: string, content: string) =>
  app.inject({ method: 'PUT', url: `/api/v1/workspaces/${id}/files/${path}`, headers, payload: { content } })

const patchFile = (id: string, path: string, search: string, replace: string) =>
  app.inject({ method: 'PATCH', url: `/api/v1/workspaces/${id}/files/${path}`, headers, payload: { search, replace } })

const deleteFile = (id: string, path: string) =>
  app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${id}/files/${path}`, headers })

describe('the tree on the API', () => {
  test('lists everything below a folder, .env files included, but never ignored folders', async () => {
    const id = await workspaceWithFiles({
      'index.html': '<h1>hi</h1>',
      '.env': 'SECRET=1',
      '.env.local': 'SECRET=2',
      '.env.example': 'SECRET=',
      'src/app.ts': 'export {}',
      'src/lib/util.ts': '',
      'node_modules/pkg/index.js': '',
      '.git/HEAD': '',
    })

    const root = await getTree(id)
    expect(root.statusCode).toBe(200)
    expect(root.json()).toEqual({
      paths: ['.env', '.env.example', '.env.local', 'index.html', 'src/', 'src/app.ts', 'src/lib/', 'src/lib/util.ts'],
    })

    expect((await getTree(id, 'src')).json()).toEqual({ paths: ['src/app.ts', 'src/lib/', 'src/lib/util.ts'] })
  })

  test('a file is not a folder to list', async () => {
    const id = await workspaceWithFiles({ 'index.html': '' })

    expect((await getTree(id, 'index.html')).statusCode).toBe(400)
    expect((await getTree(id, 'missing')).statusCode).toBe(404)
  })
})

describe('reading a file on the API', () => {
  test('returns the whole file, or the lines I ask for', async () => {
    const id = await workspaceWithFiles({ 'notes.txt': 'one\ntwo\nthree\n' })

    expect((await getFile(id, 'notes.txt')).json()).toEqual({ content: 'one\ntwo\nthree', totalLines: 3 })
    expect((await getFile(id, 'notes.txt', '?offset=1&limit=1')).json()).toEqual({ content: 'two', totalLines: 3 })
    expect((await getFile(id, 'notes.txt', '?offset=2')).json()).toEqual({ content: 'three', totalLines: 3 })
    expect((await getFile(id, 'notes.txt', '?limit=2')).json()).toEqual({ content: 'one\ntwo', totalLines: 3 })
  })

  test('a binary file is refused', async () => {
    const id = await workspaceWithFiles({ 'logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]) })

    expect((await getFile(id, 'logo.png')).statusCode).toBe(400)
  })

  test('a file over 512 KB is only read in parts', async () => {
    const id = await workspaceWithFiles({ 'big.txt': 'a\n'.repeat(300 * 1024) })

    expect((await getFile(id, 'big.txt')).statusCode).toBe(400)
    expect((await getFile(id, 'big.txt', '?limit=1')).json()).toEqual({ content: 'a', totalLines: 300 * 1024 })
  })

  test('a very long line is cut', async () => {
    const id = await workspaceWithFiles({ 'min.js': 'x'.repeat(2500) })

    expect((await getFile(id, 'min.js')).json().content).toBe(`${'x'.repeat(2000)}… [truncated]`)
  })
})

describe('changing files on the API', () => {
  test('a write creates the file and its folders, and replaces it', async () => {
    const id = await workspaceWithFiles({})

    expect((await putFile(id, 'a/b/c.txt', 'hi')).statusCode).toBe(204)
    expect(await readFile(join(dir, id, 'a/b/c.txt'), 'utf8')).toBe('hi')

    await putFile(id, 'a/b/c.txt', 'bye')
    expect(await readFile(join(dir, id, 'a/b/c.txt'), 'utf8')).toBe('bye')
  })

  test('an edit replaces text found once, exactly as given', async () => {
    const id = await workspaceWithFiles({ 'app.js': 'let a = 1\nlet b = 2' })

    expect((await patchFile(id, 'app.js', 'a = 1', 'a = $&')).statusCode).toBe(204)
    expect(await readFile(join(dir, id, 'app.js'), 'utf8')).toBe('let a = $&\nlet b = 2')
  })

  test('an edit is refused when the text is missing or found more than once, and the file stays', async () => {
    const id = await workspaceWithFiles({ 'app.js': 'x x' })

    expect((await patchFile(id, 'app.js', 'y', 'z')).statusCode).toBe(400)
    expect((await patchFile(id, 'app.js', 'x', 'z')).statusCode).toBe(409)
    expect(await readFile(join(dir, id, 'app.js'), 'utf8')).toBe('x x')
  })

  test('delete removes a file but not a folder', async () => {
    const id = await workspaceWithFiles({ 'src/app.ts': '' })

    expect((await deleteFile(id, 'src/app.ts')).statusCode).toBe(204)
    expect(existsSync(join(dir, id, 'src/app.ts'))).toBe(false)
    expect((await deleteFile(id, 'src')).statusCode).toBe(400)
  })
})

describe('paths on the API', () => {
  test('a path out of the workspace is not found, for reads and writes', async () => {
    const id = await workspaceWithFiles({})
    await writeFile(join(dir, 'secret.txt'), 'secret')

    expect((await getFile(id, '%2E%2E%2Fsecret.txt')).statusCode).toBe(404)
    expect((await putFile(id, '%2E%2E%2Fescape.txt', 'x')).statusCode).toBe(404)
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false)
  })

  test('a link leading out of the workspace is not found, for reads and writes', async () => {
    const id = await workspaceWithFiles({})
    await mkdir(join(dir, 'outside'), { recursive: true })
    await writeFile(join(dir, 'outside/secret.txt'), 'secret')
    await symlink(join(dir, 'outside'), join(dir, id, 'out'))

    expect((await getFile(id, 'out/secret.txt')).statusCode).toBe(404)
    expect((await putFile(id, 'out/new.txt', 'x')).statusCode).toBe(404)
    expect(existsSync(join(dir, 'outside/new.txt'))).toBe(false)
  })
})
