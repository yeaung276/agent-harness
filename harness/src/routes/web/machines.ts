import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'

const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'medium' })

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
        cpu: { percent: worker.cpuPercent === null ? null : Math.min(100, worker.cpuPercent), value: worker.cpuPercent },
        memory: {
          percent: percent(worker.memoryBytes, worker.memoryLimitBytes),
          used: worker.memoryBytes === null ? null : mb(worker.memoryBytes),
          limit: worker.memoryLimitBytes === null ? null : mb(worker.memoryLimitBytes),
        },
        sandboxes: {
          percent: percent(worker.sandboxes, worker.sandboxSlots),
          used: worker.sandboxes,
          total: worker.sandboxSlots,
        },
        sessions: worker.sessions,
      },
    })
  })
}
