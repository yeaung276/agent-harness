import { type PeerCertificate, checkServerIdentity } from 'node:tls'

import * as x509 from '@peculiar/x509'
import { eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'

import { workers } from '../../db/schema.ts'
import type { Db } from '../../db/type.ts'
import { logger } from '../../logger.ts'
import { HttpError } from '../http-error.ts'

x509.cryptoProvider.set(crypto)

const log = logger('workers-service')

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const
const VALID_MS = 365 * 24 * 60 * 60 * 1000
const CLOCK_SKEW_MS = 5 * 60 * 1000
const STATS_TTL_S = 30
const LOG_PAGE_LINES = 100

const newKeys = () => crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify'])

const exportKey = async (key: CryptoKey) =>
  x509.PemConverter.encode(await crypto.subtle.exportKey('pkcs8', key), 'PRIVATE KEY')

const positiveSerialNumber = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[0]! &= 0x7f
  return Buffer.from(bytes).toString('hex')
}

export const createCsr = async (hostname: string) => {
  const keys = await newKeys()
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${hostname}`,
    keys,
    signingAlgorithm: ALGORITHM,
  })

  return { key: await exportKey(keys.privateKey), csr: csr.toString('pem') }
}

export const createWorkerService = async ({
  db,
  redis,
  caKey,
  caCert,
}: {
  db: Db
  redis: Redis
  caKey: string
  caCert: string
}) => {
  const issuer = new x509.X509Certificate(caCert).subject
  const signingKey = await crypto.subtle.importKey(
    'pkcs8',
    x509.PemConverter.decodeFirst(caKey),
    { name: ALGORITHM.name, namedCurve: ALGORITHM.namedCurve },
    false,
    ['sign']
  )
  const sessions = new Map<string, Bun.FetchSession>()

  const issue = async (subject: string, publicKey: x509.PublicKey | CryptoKey, extensions: x509.Extension[]) => {
    const now = Date.now()
    const issued = await x509.X509CertificateGenerator.create({
      serialNumber: positiveSerialNumber(),
      subject,
      issuer,
      notBefore: new Date(now - CLOCK_SKEW_MS),
      notAfter: new Date(now + VALID_MS),
      publicKey,
      signingKey,
      signingAlgorithm: ALGORITHM,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        ...extensions,
      ],
    })

    return issued.toString('pem')
  }

  const signWorkerCsr = async (pem: string, hostname: string) => {
    const csr = new x509.Pkcs10CertificateRequest(pem)
    if (!(await csr.verify())) throw new HttpError(400, 'the CSR signature does not verify')
    if (csr.subject !== `CN=${hostname}`) throw new HttpError(400, `the CSR is not for ${hostname}`)

    return issue(csr.subject, csr.publicKey, [
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: hostname }]),
    ])
  }

  const issueServerCert = async () => {
    const keys = await newKeys()
    const cert = await issue('CN=server', keys.publicKey, [
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth]),
    ])

    return { key: await exportKey(keys.privateKey), cert }
  }

  const getConnectionInfo = async (name: string) => {
    const address = await redis.hget(`pods:${name}`, 'address')
    if (!address) throw new HttpError(503, `worker ${name} is not available`)

    return {
      address,
      tls: {
        ...serverCert,
        ca: caCert,
        checkServerIdentity: (_host: string, cert: PeerCertificate) => checkServerIdentity(name, cert),
      },
    }
  }

  const sessionOf = (name: string, tls: Awaited<ReturnType<typeof getConnectionInfo>>['tls']) => {
    let session = sessions.get(name)
    if (!session) {
      session = new Bun.FetchSession({ tls })
      sessions.set(name, session)
    }
    return session
  }

  const serverCert = await issueServerCert()

  return {
    serverCert,
    getConnectionInfo,

    register: async ({ hostname, address, csr }: { hostname: string; address: string; csr: string }) => {
      const cert = await signWorkerCsr(csr, hostname)
      await db
        .insert(workers)
        .values({ hostname, address })
        .onConflictDoUpdate({ target: workers.hostname, set: { address, registeredAt: new Date() } })

      const statsKey = `pods:${hostname}`
      await redis.multi().hset(statsKey, { hostname, address }).expire(statsKey, STATS_TTL_S).exec()
      log.info({ hostname, address }, 'worker registered')

      return { cert, caCert, statsKey }
    },

    list: async () => {
      const rows = await db.select().from(workers).orderBy(workers.hostname)
      const reported = await Promise.all(rows.map(row => redis.hget(`pods:${row.hostname}`, 'reportedAt')))

      return rows.map((row, i) => {
        const lastReportedAt = reported[i] ? new Date(Number(reported[i])) : null
        const live = lastReportedAt !== null && Date.now() - lastReportedAt.getTime() < STATS_TTL_S * 1000
        return { ...row, lastReportedAt, status: live ? ('live' as const) : ('stale' as const) }
      })
    },

    get: async (name: string) => {
      const [row] = await db.select().from(workers).where(eq(workers.hostname, name))
      if (!row) throw new HttpError(404, `no worker is named ${name}`)

      const stats = await redis.hgetall(`pods:${name}`)
      const lastReportedAt = stats.reportedAt ? new Date(Number(stats.reportedAt)) : null
      const live = lastReportedAt !== null && Date.now() - lastReportedAt.getTime() < STATS_TTL_S * 1000
      const number = (field: string) => (stats[field] === undefined ? null : Number(stats[field]))

      return {
        ...row,
        status: live ? ('live' as const) : ('stale' as const),
        lastReportedAt,
        cpuPercent: number('cpuPercent'),
        memoryBytes: number('memoryBytes'),
        memoryLimitBytes: number('memoryLimitBytes'),
        sandboxes: number('sandboxes'),
        sandboxSlots: number('sandboxSlots'),
        sessions: number('sessions'),
      }
    },

    logs: async (name: string, before?: string) => {
      const entries = await redis.xrevrange(`logs:${name}`, before ? `(${before}` : '+', '-', 'COUNT', LOG_PAGE_LINES)
      return entries.map(([id, fields]) => ({ id, line: fields[1] ?? '' }))
    },

    call: async (name: string, path: string, init?: RequestInit) => {
      const { address, tls } = await getConnectionInfo(name)
      return sessionOf(name, tls).fetch(`https://${address}${path}`, init)
    },
  }
}
