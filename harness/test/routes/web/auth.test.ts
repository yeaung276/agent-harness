import { afterAll, describe, expect, test } from 'bun:test'

import { loadConfig } from '../../../src/config.ts'
import { users } from '../../../src/db/schema.ts'
import { buildTestApp } from '../../test-app.ts'

const app = await buildTestApp(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }))
const email = `${crypto.randomUUID()}@example.com`
const password = 'secret-password'

await app.db.insert(users).values({ email, passwordHash: await Bun.password.hash(password, 'argon2id') })

afterAll(async () => {
  await app.close()
})

const login = (password: string) =>
  app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ email, password }).toString(),
  })

const loggedInSid = async () => (await login(password)).cookies.find(cookie => cookie.name === 'sid')!.value

describe('login', () => {
  test('the right password sets a session cookie', async () => {
    const res = await login(password)

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/')
    expect(res.cookies.find(cookie => cookie.name === 'sid')).toMatchObject({ httpOnly: true, path: '/' })
  })

  test('a wrong password sets no cookie', async () => {
    const res = await login('wrong-password')

    expect(res.statusCode).toBe(401)
    expect(res.cookies).toEqual([])
  })
})

describe('pages', () => {
  test('open with the session cookie', async () => {
    const res = await app.inject({ url: '/workspaces', cookies: { sid: await loggedInSid() } })

    expect(res.statusCode).toBe(200)
  })

  test('send you to /login without a cookie', async () => {
    const res = await app.inject('/workspaces')

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/login')
  })
})

describe('logout', () => {
  test('the cookie no longer opens pages', async () => {
    const sid = await loggedInSid()
    await app.inject({ method: 'POST', url: '/logout', cookies: { sid } })

    const res = await app.inject({ url: '/workspaces', cookies: { sid } })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/login')
  })
})
