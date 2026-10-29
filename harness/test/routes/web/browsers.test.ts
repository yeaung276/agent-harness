import { afterAll, describe, expect, test } from 'bun:test'

import { loadConfig } from '../../../src/config.ts'
import { browserActivities, browsers, users, workspaces } from '../../../src/db/schema.ts'
import { buildTestApp } from '../../test-app.ts'

const app = await buildTestApp(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }))

afterAll(async () => {
  await app.close()
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
  return { id: user!.id, email, cookies: { sid: res.cookies.find(cookie => cookie.name === 'sid')!.value } }
}

const createWorkspace = async (userId: string) => {
  const [row] = await app.db
    .insert(workspaces)
    .values({ name: `ws-${crypto.randomUUID().slice(0, 8)}`, userId })
    .returning({ id: workspaces.id })
  return row!.id
}

// the html of the row that shows this url
const rowOf = (body: string, url: string) => {
  const at = body.indexOf(url)
  return body.slice(body.lastIndexOf('<tr>', at), body.indexOf('</tr>', at))
}

describe('browsers page', () => {
  test('is in the nav below workspaces, and shows no sessions yet', async () => {
    const { cookies } = await signIn()

    const page = await app.inject({ url: '/browsers', cookies })

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('No browser sessions yet.')
    expect(page.body).toContain('aria-current="page">Browsers</a>')
    expect(page.body.indexOf('href="/browsers"')).toBeGreaterThan(page.body.indexOf('href="/workspaces"'))
    expect(page.body.indexOf('href="/browsers"')).toBeLessThan(page.body.indexOf('href="/tokens"'))
  })

  test('lists every session for everyone, with status, workspace, url, recording, who created it and when it was last used', async () => {
    const alice = await signIn()
    const bob = await signIn()
    const workspaceId = await createWorkspace(alice.id)
    await app.db.insert(browsers).values({
      userId: alice.id,
      workspaceId,
      record: true,
      status: 'closed',
      url: '/orders',
      lastUsedAt: new Date(Date.UTC(2026, 2, 4, 9, 30)),
    })

    const page = await app.inject({ url: '/browsers', cookies: bob.cookies })
    const row = rowOf(page.body, '/orders')

    expect(page.statusCode).toBe(200)
    expect(row).toContain('closed')
    expect(row).toContain(`href="/workspaces/${workspaceId}"`)
    expect(row).toContain('Yes')
    expect(row).toContain(alice.email)
    expect(row).toContain('Mar 4, 2026')
  })

  test("a session's workspace links to the workspace page, and a session without one shows a dash", async () => {
    const { id, cookies } = await signIn()
    const workspaceId = await createWorkspace(id)
    await app.db.insert(browsers).values([
      { userId: id, workspaceId, url: 'http://with-workspace.test/' },
      { userId: id, workspaceId: null, url: 'http://without-workspace.test/' },
    ])

    const page = await app.inject({ url: '/browsers', cookies })
    const linked = rowOf(page.body, 'http://with-workspace.test/')
    const unlinked = rowOf(page.body, 'http://without-workspace.test/')

    expect(linked).toContain(`<a href="/workspaces/${workspaceId}"`)
    expect(unlinked).not.toContain('href="/workspaces/')
    expect(unlinked).toContain('—')
  })

  test('sessions are sorted by last used, newest first, then by created', async () => {
    const { id, cookies } = await signIn()
    await app.db.insert(browsers).values([
      {
        userId: id,
        url: 'http://used-first.test/',
        lastUsedAt: new Date(Date.UTC(2100, 0, 1)),
        createdAt: new Date(Date.UTC(2100, 0, 1)),
      },
      {
        userId: id,
        url: 'http://created-first.test/',
        lastUsedAt: new Date(Date.UTC(2100, 0, 2)),
        createdAt: new Date(Date.UTC(2100, 0, 1)),
      },
      {
        userId: id,
        url: 'http://created-last.test/',
        lastUsedAt: new Date(Date.UTC(2100, 0, 2)),
        createdAt: new Date(Date.UTC(2100, 0, 2)),
      },
    ])

    const page = await app.inject({ url: '/browsers', cookies })

    expect(page.body.indexOf('http://created-last.test/')).toBeLessThan(page.body.indexOf('http://created-first.test/'))
    expect(page.body.indexOf('http://created-first.test/')).toBeLessThan(page.body.indexOf('http://used-first.test/'))
  })

  test('sessions are 20 to a page, with previous and next links', async () => {
    const { id, cookies } = await signIn()
    // used after every other session in this file, so they sort to the top
    await app.db.insert(browsers).values(
      Array.from({ length: 25 }, (_, index) => ({
        userId: id,
        url: `http://page.test/${index + 1}/`,
        lastUsedAt: new Date(Date.UTC(2200, 0, 1, 0, 0, index)),
      }))
    )
    const total = await app.db.$count(browsers)

    const first = await app.inject({ url: '/browsers', cookies })
    const second = await app.inject({ url: '/browsers?page=2', cookies })

    for (let n = 25; n >= 6; n--) expect(first.body).toContain(`http://page.test/${n}/`)
    expect(first.body).not.toContain('http://page.test/5/')
    expect(first.body).toContain(`1–20 of ${total}`)
    expect(first.body).toContain('text-gray-300">Previous</span>')
    expect(first.body).toContain('href="/browsers?page=2"')

    expect(second.body.indexOf('http://page.test/5/')).toBeLessThan(second.body.indexOf('http://page.test/1/'))
    expect(second.body).not.toContain('http://page.test/6/')
    expect(second.body).toContain(`21–${Math.min(40, total)} of ${total}`)
    expect(second.body).toContain('href="/browsers?page=1"')
  })

  test('a page past the end says so, and page 0 is refused', async () => {
    const { cookies } = await signIn()
    const total = await app.db.$count(browsers)

    const past = await app.inject({ url: '/browsers?page=1000', cookies })
    const zero = await app.inject({ url: '/browsers?page=0', cookies })

    expect(past.statusCode).toBe(200)
    expect(past.body).toContain('No browser sessions on this page.')
    expect(past.body).toContain(`${total} in all`)
    expect(zero.statusCode).toBe(400)
  })

  test('needs a login', async () => {
    const res = await app.inject({ url: '/browsers' })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/login')
  })
})

describe('browser activity', () => {
  test('lists calls newest first, 20 to a page, and refuses an unknown session', async () => {
    const { id: userId, cookies } = await signIn()
    const [browser] = await app.db.insert(browsers).values({ userId }).returning({ id: browsers.id })
    const id = browser!.id
    await app.db.insert(browserActivities).values(
      Array.from({ length: 25 }, (_, index) => ({
        browserId: id,
        kind: 'click' as const,
        command: `ref ${index + 1}`,
        status: 'succeeded' as const,
        output: `page ${index + 1}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      }))
    )

    const first = (await app.inject({ url: `/browsers/${id}/activities`, cookies })).json()
    const second = (await app.inject({ url: `/browsers/${id}/activities?page=2`, cookies })).json()

    expect(first.items).toHaveLength(20)
    expect(first.items[0]).toMatchObject({ kind: 'click', command: 'ref 25', status: 'succeeded', output: 'page 25' })
    expect(first.pagination).toEqual({ from: 1, to: 20, total: 25, prev: null, next: 2 })
    expect(second.items).toHaveLength(5)
    expect(second.pagination).toEqual({ from: 21, to: 25, total: 25, prev: 1, next: null })
    expect((await app.inject({ url: `/browsers/${crypto.randomUUID()}/activities`, cookies })).statusCode).toBe(404)
  })

  test("shows a workspace page by its path, and another site's in full", async () => {
    const { id: userId, cookies } = await signIn()
    const [browser] = await app.db.insert(browsers).values({ userId }).returning({ id: browsers.id })
    const id = browser!.id
    const page = { text: '', refs: [] }
    await app.services.browserActivities.record(id, 'navigate', '/orders', {
      result: { ...page, title: 'Orders', url: 'http://127.0.0.1:4120/orders' },
      error: null,
    })
    await app.services.browserActivities.record(id, 'navigate', 'https://example.com/', {
      result: { ...page, title: 'Example', url: 'https://example.com/' },
      error: null,
    })

    const { items } = (await app.inject({ url: `/browsers/${id}/activities`, cookies })).json()

    expect(items.map((item: { output: string }) => item.output).sort()).toEqual([
      'Example · https://example.com/',
      'Orders · /orders',
    ])
  })
})
