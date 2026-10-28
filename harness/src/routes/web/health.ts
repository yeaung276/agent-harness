import { setTimeout } from 'node:timers/promises'

import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { sql } from 'drizzle-orm'
import { Type } from 'typebox'

const PROBE_TIMEOUT_MS = 2000

const Check = Type.Union([Type.Literal('up'), Type.Literal('down')])
const Readiness = Type.Object({
  status: Type.Union([Type.Literal('ready'), Type.Literal('not-ready')]),
  checks: Type.Object({ postgres: Check, redis: Check }),
})

const timeout = (ms: number) =>
  setTimeout(ms, undefined, { ref: false }).then(() => {
    throw new Error(`timed out after ${ms}ms`)
  })

export const health: FastifyPluginAsyncTypebox = async app => {
  const probe = async (name: string, check: () => Promise<unknown>): Promise<'up' | 'down'> => {
    try {
      await Promise.race([check(), timeout(PROBE_TIMEOUT_MS)])
      return 'up'
    } catch (err) {
      app.log.warn({ err }, `${name} readiness check failed`)
      return 'down'
    }
  }

  app.get('/healthz', { schema: { response: { 200: Type.Object({ status: Type.Literal('ok') }) } } }, async () => ({
    status: 'ok' as const,
  }))

  app.get('/readyz', { schema: { response: { 200: Readiness, 503: Readiness } } }, async (_request, reply) => {
    const [postgres, redis] = await Promise.all([
      probe('postgres', () => app.db.execute(sql`select 1`)),
      probe('redis', () => app.redis.ping()),
    ])
    const ready = postgres === 'up' && redis === 'up'

    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not-ready', checks: { postgres, redis } })
  })
}
