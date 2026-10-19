import { afterAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { buildApp } from '../../../src/app.ts'
import { loadConfig } from '../../../src/config.ts'
import { users } from '../../../src/db/schema.ts'

const app = await buildApp(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }))
const email = `${crypto.randomUUID()}@example.com`

const [user] = await app.db
  .insert(users)
  .values({ email, passwordHash: await Bun.password.hash('secret-password', 'argon2id') })
  .returning({ id: users.id })

afterAll(async () => {
  await app.db.delete(users).where(eq(users.email, email))
  await app.close()
})

const callMe = (authorization?: string) =>
  app.inject({ url: '/api/v1/me', headers: authorization ? { authorization } : {} })

const expectRefused = (res: Awaited<ReturnType<typeof callMe>>) => {
  expect(res.statusCode).toBe(401)
  expect(res.headers['www-authenticate']).toBe('Bearer')
  expect(res.json()).toEqual({ error: 'Unauthorized' })
}

describe('calling the API', () => {
  test('my token opens /me as me', async () => {
    const token = await app.services.tokens.create(user!.id, { name: 'ci', expiresInDays: null })

    const res = await callMe(`Bearer ${token}`)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: user!.id, email })
  })

  test('a call without a token is refused', async () => {
    expectRefused(await callMe())
  })

  test('a made-up token is refused', async () => {
    expectRefused(await callMe(`Bearer pat_${crypto.randomUUID()}`))
  })

  test('an expired token is refused', async () => {
    const token = await app.services.tokens.create(user!.id, { name: 'old', expiresInDays: -1 })

    expectRefused(await callMe(`Bearer ${token}`))
  })
})
