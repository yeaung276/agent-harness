import { afterAll, describe, expect, test } from 'bun:test'

import { loadConfig } from '../../../src/config.ts'
import { users } from '../../../src/db/schema.ts'
import { buildTestApp } from '../../test-app.ts'

const app = await buildTestApp(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }))

afterAll(async () => {
  await app.close()
})

const form = { 'content-type': 'application/x-www-form-urlencoded' }

// a new user, logged in
const signIn = async () => {
  const email = `${crypto.randomUUID()}@example.com`
  await app.db.insert(users).values({ email, passwordHash: await Bun.password.hash('secret-password', 'argon2id') })
  const res = await app.inject({
    method: 'POST',
    url: '/login',
    headers: form,
    payload: new URLSearchParams({ email, password: 'secret-password' }).toString(),
  })
  return { sid: res.cookies.find(cookie => cookie.name === 'sid')!.value }
}

describe('browsers page', () => {
  test('is in the nav below workspaces, and shows no sessions yet', async () => {
    const cookies = await signIn()

    const page = await app.inject({ url: '/browsers', cookies })

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('No browser sessions.')
    expect(page.body).toContain('aria-current="page">Browsers</a>')
    expect(page.body.indexOf('href="/browsers"')).toBeGreaterThan(page.body.indexOf('href="/workspaces"'))
    expect(page.body.indexOf('href="/browsers"')).toBeLessThan(page.body.indexOf('href="/tokens"'))
  })

  test('needs a login', async () => {
    const res = await app.inject({ url: '/browsers' })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/login')
  })
})
