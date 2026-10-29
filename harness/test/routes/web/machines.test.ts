import { afterAll, describe, expect, test } from 'bun:test'

import { loadConfig } from '../../../src/config.ts'
import { users, workers as workersTable } from '../../../src/db/schema.ts'
import { workers } from '../../../src/plugins/workers.ts'
import { buildTestApp } from '../../test-app.ts'
import { createTestCa } from '../../worker-ca.ts'

const ca = await createTestCa()
const app = await buildTestApp(
  loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WORKER_CA_KEY: ca.key,
    WORKER_CA_CERT: ca.cert,
  })
)
await app.register(workers)

afterAll(() => app.close())

const form = { 'content-type': 'application/x-www-form-urlencoded' }

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

const rowOf = (body: string, name: string) => {
  const at = body.indexOf(name)
  return body.slice(body.lastIndexOf('<tr>', at), body.indexOf('</tr>', at))
}

describe('machines page', () => {
  test('is in the nav below browsers, and shows no workers yet', async () => {
    const page = await app.inject({ url: '/machines', cookies: await signIn() })

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('No workers have registered yet.')
    expect(page.body).toContain('aria-current="page">Machines</a>')
    expect(page.body.indexOf('href="/machines"')).toBeGreaterThan(page.body.indexOf('href="/browsers"'))
  })

  test('shows a worker that reported recently as live, and one that never reported or went quiet as stale', async () => {
    await app.db.insert(workersTable).values([
      { hostname: 'worker-live', address: '10.0.0.1:3000' },
      { hostname: 'worker-quiet', address: '10.0.0.2:3000' },
      { hostname: 'worker-never', address: '10.0.0.3:3000' },
    ])
    await app.redis.hset('pods:worker-live', 'reportedAt', Date.now())
    await app.redis.hset('pods:worker-quiet', 'reportedAt', Date.now() - 60_000)

    const page = await app.inject({ url: '/machines', cookies: await signIn() })

    expect(rowOf(page.body, 'worker-live')).toContain('live')
    expect(rowOf(page.body, 'worker-live')).toContain('10.0.0.1:3000')
    expect(rowOf(page.body, 'worker-quiet')).toContain('stale')
    expect(rowOf(page.body, 'worker-never')).toContain('stale')
    expect(rowOf(page.body, 'worker-never')).toContain('Never')
    expect(rowOf(page.body, 'worker-live')).toContain('href="/machines/worker-live"')
  })
})

describe('machine detail page', () => {
  test('shows the latest stats of a worker', async () => {
    await app.db.insert(workersTable).values({ hostname: 'worker-detail', address: '10.0.0.9:3000' })
    await app.redis.hset('pods:worker-detail', {
      reportedAt: Date.now(),
      cpuPercent: 42,
      memoryBytes: 512 * 1024 * 1024,
      memoryLimitBytes: 2048 * 1024 * 1024,
      sandboxes: 5,
      sandboxSlots: 50,
      sessions: 3,
    })

    const page = await app.inject({ url: '/machines/worker-detail', cookies: await signIn() })

    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('10.0.0.9:3000')
    expect(page.body).toContain('42%')
    expect(page.body).toContain('512 MB')
    expect(page.body).toContain('of 2048 MB')
    expect(page.body).toContain('5 / 50')
    expect(page.body).toContain('stroke-dasharray="10 100"')
  })

  test('answers 404 for an unknown worker', async () => {
    const page = await app.inject({ url: '/machines/nobody', cookies: await signIn() })

    expect(page.statusCode).toBe(404)
  })
})
