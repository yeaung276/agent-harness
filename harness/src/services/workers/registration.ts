import { networkInterfaces } from 'node:os'

import * as x509 from '@peculiar/x509'

import type { Config } from '../../config.ts'
import { logger } from '../../logger.ts'
import { createCsr } from './index.ts'
import { open, type Sealed, seal } from './seal.ts'
import { createStatsReporter } from './stats-reporter.ts'

const log = logger('registration')

type Reply = { cert: string; caCert: string; statsKey: string; nonce: string }

const ownIp = () =>
  Object.values(networkInterfaces())
    .flat()
    .find(nic => nic?.family === 'IPv4' && !nic.internal)?.address

export const registerWithServer = async ({ WORKER_NAME, SERVER_URL, WORKER_JOIN_SECRET, PORT }: Config) => {
  if (!WORKER_NAME || !SERVER_URL || !WORKER_JOIN_SECRET) {
    throw new Error('a worker needs WORKER_NAME, SERVER_URL and WORKER_JOIN_SECRET to register')
  }
  const ip = ownIp()
  if (!ip) throw new Error('the worker has no IPv4 address to register')

  const { key, csr } = await createCsr(WORKER_NAME)
  const address = `${ip}:${PORT}`
  const sent = seal(WORKER_JOIN_SECRET, { hostname: WORKER_NAME, address, csr, time: Date.now() })

  const res = await fetch(new URL('/workers/register', SERVER_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sent),
  })
  if (!res.ok) throw new Error(`the server refused the registration: ${res.status} ${await res.text()}`)

  const reply = open(WORKER_JOIN_SECRET, (await res.json()) as Sealed) as Reply
  if (reply.nonce !== sent.nonce) throw new Error('the registration reply answers another request')

  const expiresAt = new x509.X509Certificate(reply.cert).notAfter
  log.info({ name: WORKER_NAME, address, expiresAt }, 'registered with the server')

  return {
    https: { key, cert: reply.cert, ca: reply.caCert, requestCert: true, rejectUnauthorized: true },
    statsReporter: createStatsReporter({ statsKey: reply.statsKey, hostname: WORKER_NAME, address }),
  }
}

export type Registration = Awaited<ReturnType<typeof registerWithServer>>
