import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'

const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'medium' })

const STREAM_ID = '^(\\$|\\d+-\\d+)$'
const LIVE_BLOCK_MS = 15_000

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`

export const machines: FastifyPluginAsyncTypebox = async app => {
  app.get('/machines', async (_request, reply) => {
    const workers = await app.workers.list()

    return reply.viewAsync('machines', {
      title: 'Machines',
      active: 'machines',
      machines: workers.map(worker => ({
        name: worker.hostname,
        address: worker.address,
        status: worker.status,
        lastReported: worker.lastReportedAt ? date.format(worker.lastReportedAt) : null,
        registered: date.format(worker.registeredAt),
      })),
    })
  })

  app.get('/machines/:name', { schema: { params: Type.Object({ name: Type.String() }) } }, async (request, reply) => {
    const worker = await app.workers.get(request.params.name)
    const percent = (used: number | null, total: number | null) =>
      used === null || !total ? null : Math.min(100, Math.round((used / total) * 100))

    return reply.viewAsync('machine', {
      title: worker.hostname,
      active: 'machines',
      machine: {
        name: worker.hostname,
        address: worker.address,
        status: worker.status,
        lastReported: worker.lastReportedAt ? date.format(worker.lastReportedAt) : null,
        registered: date.format(worker.registeredAt),
        cpu: {
          percent: worker.cpuPercent === null ? null : Math.min(100, worker.cpuPercent),
          value: worker.cpuPercent,
        },
        memory: {
          percent: percent(worker.memoryBytes, worker.memoryLimitBytes),
          used: worker.memoryBytes === null ? null : mb(worker.memoryBytes),
          limit: worker.memoryLimitBytes === null ? null : mb(worker.memoryLimitBytes),
        },
        sandboxes: worker.sandboxes,
        sandboxSlots: worker.sandboxSlots,
        sessions: worker.sessions,
      },
    })
  })

  app.get(
    '/machines/:name/logs',
    {
      schema: {
        params: Type.Object({ name: Type.String() }),
        querystring: Type.Object({ before: Type.Optional(Type.String({ pattern: STREAM_ID })) }),
      },
    },
    async request => ({ lines: await app.workers.logs(request.params.name, request.query.before) })
  )

  app.get(
    '/machines/:name/logs/live',
    {
      schema: {
        params: Type.Object({ name: Type.String() }),
        querystring: Type.Object({ after: Type.String({ pattern: STREAM_ID, default: '$' }) }),
      },
    },
    async (request, reply) => {
      const key = `logs:${request.params.name}`
      // XREAD BLOCK holds its connection, so each live view reads on one of its own
      const reader = app.redis.duplicate()
      const lastEventId = request.headers['last-event-id']
      let after =
        typeof lastEventId === 'string' && new RegExp(STREAM_ID).test(lastEventId) ? lastEventId : request.query.after
      let open = true
      request.raw.once('close', () => {
        open = false
        reader.disconnect()
      })

      reply.hijack()
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })

      while (open) {
        const read = await reader.xread('BLOCK', LIVE_BLOCK_MS, 'STREAMS', key, after).catch(() => null)
        if (!open) break
        if (!read) {
          reply.raw.write(': idle\n\n')
          continue
        }
        for (const [id, fields] of read[0]![1]) {
          after = id
          reply.raw.write(`id: ${id}\ndata: ${JSON.stringify({ id, line: fields[1] ?? '' })}\n\n`)
        }
      }
    }
  )
}
