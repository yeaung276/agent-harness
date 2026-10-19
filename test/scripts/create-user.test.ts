import { join } from 'node:path'

import { afterAll, describe, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'

import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { users } from '../../src/db/schema.ts'

const app = await buildApp(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }))
const emails: string[] = []

const newEmail = () => {
  const email = `${crypto.randomUUID()}@example.com`
  emails.push(email)
  return email
}

const createUser = async (email: string, password: string) => {
  const proc = Bun.spawn(['bun', join(import.meta.dirname, '../../scripts/create-user.ts'), email], {
    stdin: new Blob([`${password}\n`]),
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  return { stderr, exitCode }
}

afterAll(async () => {
  await app.db.delete(users).where(inArray(users.email, emails))
  await app.close()
})

describe('user:create', () => {
  test('the new user can log in', async () => {
    const email = newEmail()
    expect((await createUser(email, 'secret-password')).exitCode).toBe(0)

    const res = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ email, password: 'secret-password' }).toString(),
    })

    expect(res.statusCode).toBe(302)
    expect(res.cookies.map(cookie => cookie.name)).toContain('sid')
  })

  test('the same email cannot be added twice', async () => {
    const email = newEmail()
    await createUser(email, 'secret-password')

    const { stderr, exitCode } = await createUser(email, 'another-password')

    expect(exitCode).toBe(1)
    expect(stderr).toContain('already exists')
  })
})
