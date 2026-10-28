import { afterAll, describe, expect, test } from 'bun:test'

import { loadConfig } from '../../../src/config.ts'
import { workers } from '../../../src/plugins/workers.ts'
import { workerRoutes } from '../../../src/routes/workers/index.ts'
import { createCsr } from '../../../src/services/workers/index.ts'
import { open, type Sealed, seal } from '../../../src/services/workers/seal.ts'
import { buildTestApp } from '../../test-app.ts'
import { createTestCa } from '../../worker-ca.ts'

const SECRET = 'j'.repeat(32)
const ca = await createTestCa()

const app = await buildTestApp(
  loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://unused',
    REDIS_URL: 'redis://unused',
    DATA_ENCRYPTION_KEY: '0'.repeat(64),
    WORKER_JOIN_SECRET: SECRET,
    WORKER_CA_KEY: ca.key,
    WORKER_CA_CERT: ca.cert,
  })
)
await app.register(workers)
await app.register(workerRoutes, { prefix: '/workers' })

afterAll(() => app.close())

const post = (payload: Sealed) => app.inject({ method: 'POST', url: '/workers/register', payload })

const registration = async (overrides: Record<string, unknown> = {}) => ({
  hostname: 'worker-0',
  address: '10.0.0.5:3000',
  csr: (await createCsr('worker-0')).csr,
  time: Date.now(),
  ...overrides,
})

describe('POST /workers/register', () => {
  test('answers sealed with the certificate, the CA certificate, the stats key and the request nonce', async () => {
    const sent = seal(SECRET, await registration())
    const res = await post(sent)

    expect(res.statusCode).toBe(200)
    expect(open(SECRET, res.json())).toMatchObject({ caCert: ca.cert, statsKey: 'pods:worker-0', nonce: sent.nonce })
  })

  test('refuses a registration sealed with another secret', async () => {
    expect((await post(seal('x'.repeat(32), await registration()))).statusCode).toBe(401)
  })

  test('refuses an old registration', async () => {
    expect((await post(seal(SECRET, await registration({ time: Date.now() - 120_000 })))).statusCode).toBe(401)
  })

  test('refuses a malformed registration', async () => {
    expect((await post(seal(SECRET, await registration({ hostname: 'Not A Hostname' })))).statusCode).toBe(400)
  })

  test('refuses a CSR for another hostname', async () => {
    const { csr } = await createCsr('worker-1')

    expect((await post(seal(SECRET, await registration({ csr })))).statusCode).toBe(400)
  })
})
