import { afterAll, describe, expect, test } from 'bun:test'
import { X509Certificate } from 'node:crypto'

import { loadConfig } from '../../../src/config.ts'
import { workers as workersTable } from '../../../src/db/schema.ts'
import { workers } from '../../../src/plugins/workers.ts'
import { createCsr } from '../../../src/services/workers/index.ts'
import { buildTestApp } from '../../test-app.ts'
import { createTestCa } from '../../worker-ca.ts'

const SERVER_AUTH = '1.3.6.1.5.5.7.3.1'
const CLIENT_AUTH = '1.3.6.1.5.5.7.3.2'

const ca = await createTestCa()
const caCert = new X509Certificate(ca.cert)

const app = await buildTestApp(
  loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://unused',
    REDIS_URL: 'redis://unused',
    DATA_ENCRYPTION_KEY: '0'.repeat(64),
    WORKER_CA_KEY: ca.key,
    WORKER_CA_CERT: ca.cert,
  })
)
await app.register(workers)
await app.ready()

afterAll(() => app.close())

describe('the server certificate', () => {
  test('is signed by the CA for client auth only', () => {
    const cert = new X509Certificate(app.workers.serverCert.cert)

    expect(cert.verify(caCert.publicKey)).toBeTrue()
    expect(cert.subject).toBe('CN=server')
    expect(cert.keyUsage).toEqual([CLIENT_AUTH])
  })
})

describe('register', () => {
  test('signs the worker certificate for server auth under its hostname', async () => {
    const { csr } = await createCsr('worker-0')
    const registered = await app.workers.register({ hostname: 'worker-0', address: '10.0.0.5:3000', csr })
    const cert = new X509Certificate(registered.cert)

    expect(cert.verify(caCert.publicKey)).toBeTrue()
    expect(cert.subject).toBe('CN=worker-0')
    expect(cert.subjectAltName).toBe('DNS:worker-0')
    expect(cert.keyUsage).toEqual([SERVER_AUTH])
    expect(registered.caCert).toBe(ca.cert)
    expect(registered.statsKey).toBe('pods:worker-0')
  })

  test('records the worker and writes its address for routing', async () => {
    const { csr } = await createCsr('worker-1')
    await app.workers.register({ hostname: 'worker-1', address: '10.0.0.6:3000', csr })

    expect(await app.redis.hgetall('pods:worker-1')).toEqual({ hostname: 'worker-1', address: '10.0.0.6:3000' })
    expect(await app.redis.ttl('pods:worker-1')).toBeGreaterThan(0)
    expect(await app.db.select().from(workersTable)).toContainEqual(
      expect.objectContaining({ hostname: 'worker-1', address: '10.0.0.6:3000' })
    )
  })

  test('refuses a CSR for another hostname', async () => {
    const { csr } = await createCsr('worker-2')

    await expect(app.workers.register({ hostname: 'worker-0', address: 'a:1', csr })).rejects.toMatchObject({
      status: 400,
    })
  })
})
