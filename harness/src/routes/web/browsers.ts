import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'

import { HttpError } from '../../services/http-error.ts'
import { ActivitiesQuery, BrowserParams, BrowsersQuery } from './schemas/browsers.ts'

const PAGE_SIZE = 20

const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })

export const browsers: FastifyPluginAsyncTypebox = async app => {
  app.get('/browsers', { schema: { querystring: BrowsersQuery } }, async (request, reply) => {
    const { page } = request.query
    const offset = (page - 1) * PAGE_SIZE
    const { items, total } = await app.services.browsers.list({ limit: PAGE_SIZE, offset })

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

  app.get('/browsers/:id', { schema: { params: BrowserParams } }, async (request, reply) => {
    const session = await app.services.browsers.get(request.params.id)
    if (!session) throw new HttpError(404, 'No session has this id')

    return reply.viewAsync('browser', { title: session.url ?? 'Browser', active: 'browsers', session })
  })

  app.get(
    '/browsers/:id/activities',
    { schema: { params: BrowserParams, querystring: ActivitiesQuery } },
    async request => {
      const { id } = request.params
      const session = await app.services.browsers.get(id)
      if (!session) throw new HttpError(404, 'No session has this id')
      const offset = (request.query.page - 1) * PAGE_SIZE
      const { items, total } = await app.services.browserActivities.list(id, { limit: PAGE_SIZE, offset })

      return {
        items,
        pagination: {
          from: offset + 1,
          to: offset + items.length,
          total,
          prev: request.query.page > 1 ? request.query.page - 1 : null,
          next: offset + items.length < total ? request.query.page + 1 : null,
        },
      }
    }
  )
}
