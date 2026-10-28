import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'

import { BrowsersQuery } from './schemas/browsers.ts'

const PAGE_SIZE = 20

const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })

export const browsers: FastifyPluginAsyncTypebox = async app => {
  app.get('/browsers', { schema: { querystring: BrowsersQuery } }, async (request, reply) => {
    const { page } = request.query
    const offset = (page - 1) * PAGE_SIZE
    const { items, total } = await app.services.browserSessions.list({ limit: PAGE_SIZE, offset })

    return reply.viewAsync('browsers', {
      title: 'Browsers',
      active: 'browsers',
      sessions: items.map(item => ({
        id: item.id,
        status: item.status,
        workspaceId: item.workspaceId,
        url: item.url,
        record: item.record,
        createdBy: item.createdBy,
        lastUsed: date.format(item.lastUsedAt),
        created: date.format(item.createdAt),
      })),
      pagination: {
        from: offset + 1,
        to: offset + items.length,
        total,
        prev: page > 1 ? page - 1 : null,
        next: offset + items.length < total ? page + 1 : null,
      },
    })
  })
}
