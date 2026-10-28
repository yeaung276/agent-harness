import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'
import { Value } from 'typebox/value'

import { HttpError } from '../../services/http-error.ts'
import { open, seal } from '../../services/workers/seal.ts'

const MAX_CLOCK_DRIFT_MS = 60_000

const Sealed = Type.Object({ nonce: Type.String({ minLength: 1 }), data: Type.String({ minLength: 1 }) })

const Registration = Type.Object({
  hostname: Type.String({ pattern: '^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$' }),
  address: Type.String({ minLength: 1 }),
  csr: Type.String({ minLength: 1 }),
  time: Type.Number(),
})

export const workerRoutes: FastifyPluginAsyncTypebox = async app => {
  const secret = app.config.WORKER_JOIN_SECRET
  if (!secret) throw new Error('the server needs WORKER_JOIN_SECRET for its workers')

  app.post('/register', { schema: { body: Sealed, response: { 200: Sealed } } }, async request => {
    let registration: unknown
    try {
      registration = open(secret, request.body)
    } catch {
      throw new HttpError(401, 'the registration is not sealed with the join secret')
    }
    if (!Value.Check(Registration, registration)) throw new HttpError(400, 'the registration is malformed')
    if (Math.abs(Date.now() - registration.time) > MAX_CLOCK_DRIFT_MS) throw new HttpError(401, 'the registration is too old')

    return seal(secret, { ...(await app.workers.register(registration)), nonce: request.body.nonce })
  })
}
