import { describe, expect, test } from 'bun:test'
import { X509Certificate } from 'node:crypto'

import { createCa, createCsr } from '../../../src/services/workers/certs.ts'
import { createTestCa } from '../../worker-ca.ts'

const SERVER_AUTH = '1.3.6.1.5.5.7.3.1'
const CLIENT_AUTH = '1.3.6.1.5.5.7.3.2'

const caPem = await createTestCa()
const ca = await createCa(caPem)
const caCert = new X509Certificate(caPem.cert)

describe('createCa', () => {
  test('signs a worker CSR for server auth under its hostname', async () => {
    const { csr } = await createCsr('worker-0')
    const cert = new X509Certificate(await ca.signWorkerCsr(csr, 'worker-0'))

    expect(cert.verify(caCert.publicKey)).toBeTrue()
    expect(cert.subject).toBe('CN=worker-0')
    expect(cert.subjectAltName).toBe('DNS:worker-0')
    expect(cert.keyUsage).toEqual([SERVER_AUTH])
  })

  test('refuses a CSR for another hostname', async () => {
    const { csr } = await createCsr('worker-1')

    await expect(ca.signWorkerCsr(csr, 'worker-0')).rejects.toMatchObject({ status: 400 })
  })

  test('issues the server a certificate for client auth only', async () => {
    const { cert } = await ca.issueServerCert()
    const parsed = new X509Certificate(cert)

    expect(parsed.verify(caCert.publicKey)).toBeTrue()
    expect(parsed.subject).toBe('CN=server')
    expect(parsed.keyUsage).toEqual([CLIENT_AUTH])
  })
})
