import { afterAll, describe, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'

import { buildApp } from '../../../src/app.ts'
import { loadConfig } from '../../../src/config.ts'
import { users } from '../../../src/db/schema.ts'

const app = await buildApp(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }))
const emails: string[] = []

afterAll(async () => {
  await app.db.delete(users).where(inArray(users.email, emails))
  await app.close()
})

const form = { 'content-type': 'application/x-www-form-urlencoded' }

// a new user, logged in
const signIn = async () => {
  const email = `${crypto.randomUUID()}@example.com`
  emails.push(email)
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
  return { email, userId: user!.id, cookies: { sid: res.cookies.find(cookie => cookie.name === 'sid')!.value } }
}

const createToken = async (cookies: { sid: string }, name = `token-${crypto.randomUUID()}`) => {
  const res = await app.inject({
    method: 'POST',
    url: '/tokens',
    cookies,
    headers: form,
    payload: new URLSearchParams({ name, expiresIn: '30' }).toString(),
  })
  return { res, name, token: res.body.match(/pat_[\w-]{43}/)?.[0] }
}

const callMe = (token: string) => app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } })

describe('API tokens page', () => {
  test('a new token is shown once, then only its start', async () => {
    const { cookies } = await signIn()

    const { res, token } = await createToken(cookies)
    expect(res.statusCode).toBe(200)
    expect(token).toBeDefined()

    const list = await app.inject({ url: '/tokens', cookies })
    expect(list.body).not.toContain(token)
    expect(list.body).toContain(token!.slice(0, 8))
  })

  test('the new token works on the API', async () => {
    const { cookies } = await signIn()
    const { token } = await createToken(cookies)

    expect((await callMe(token!)).statusCode).toBe(200)
  })

  test('a call on the API shows up as the last use', async () => {
    const { cookies } = await signIn()
    const { name, token } = await createToken(cookies)
    // the token expires in 30 days, so 'Never' in its row can only be Last used
    const row = async () => (await app.inject({ url: '/tokens', cookies })).body.match(new RegExp(`${name}</td>[\\s\\S]*?</tr>`))![0]
    expect(await row()).toContain('Never')

    await callMe(token!)

    expect(await row()).not.toContain('Never')
  })

  test('everyone sees a token and who created it', async () => {
    const alice = await signIn()
    const bob = await signIn()
    const { token } = await createToken(alice.cookies)

    const list = await app.inject({ url: '/tokens', cookies: bob.cookies })

    expect(list.body).toContain(token!.slice(0, 8))
    expect(list.body).toContain(alice.email)
  })

  test("anyone can revoke anyone's token, and it stops working", async () => {
    const alice = await signIn()
    const bob = await signIn()
    const { name, token } = await createToken(alice.cookies)
    const { items } = await app.services.tokens.list({ limit: 20, offset: 0 })

    await app.inject({ method: 'POST', url: `/tokens/${items.find(item => item.name === name)!.id}/delete`, cookies: bob.cookies })

    expect((await callMe(token!)).statusCode).toBe(401)
  })

  test('more than 20 tokens are split into pages', async () => {
    const { userId, cookies } = await signIn()
    for (let i = 0; i < 21; i++) await app.services.tokens.create(userId, { name: `token-${i}`, expiresInDays: 30 })
    const { total } = await app.services.tokens.list({ limit: 1, offset: 0 })
    const rows = (html: string) => html.match(/\/delete"/g)?.length ?? 0

    const first = await app.inject({ url: '/tokens', cookies })
    expect(rows(first.body)).toBe(20)
    expect(first.body).toContain(`1–20 of ${total}`)
    expect(first.body).toContain('href="/tokens?page=2"')

    const second = await app.inject({ url: '/tokens?page=2', cookies })
    expect(rows(second.body)).toBe(Math.min(20, total - 20))
    expect(second.body).toContain(`21–${Math.min(40, total)} of ${total}`)
  })
})
