import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'

import { CreateTokenBody, TokenParams, TokensQuery } from './schemas/tokens.ts'

const PAGE_SIZE = 20

const EXPIRES_IN_DAYS = { '30': 30, '90': 90, '365': 365, never: null }

const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium' })

export const tokens: FastifyPluginAsyncTypebox = async app => {
  const view = async (page: number, created: { name: string; token: string } | null = null) => {
    const offset = (page - 1) * PAGE_SIZE
    const { items, total } = await app.services.tokens.list({ limit: PAGE_SIZE, offset })

    return {
      title: 'API tokens',
      active: 'tokens',
      created,
      tokens: items.map(item => ({
        id: item.id,
        name: item.name,
        tokenStart: item.tokenStart,
        createdBy: item.createdBy,
        expires: item.expiresAt ? date.format(item.expiresAt) : 'Never',
        lastUsed: item.lastUsedAt ? date.format(item.lastUsedAt) : 'Never',
        created: date.format(item.createdAt),
      })),
      pagination: {
        from: offset + 1,
        to: offset + items.length,
        total,
        prev: page > 1 ? page - 1 : null,
        next: offset + items.length < total ? page + 1 : null,
      },
    }
  }

  app.get('/tokens', { schema: { querystring: TokensQuery } }, async (request, reply) =>
    reply.viewAsync('tokens', await view(request.query.page))
  )

  // the new token is in this response only; it is not stored and can't be shown again
  app.post('/tokens', { schema: { body: CreateTokenBody } }, async (request, reply) => {
    const name = request.body.name.trim()
    const token = await app.services.tokens.create(request.userId, {
      name,
      expiresInDays: EXPIRES_IN_DAYS[request.body.expiresIn],
    })

    return reply.viewAsync('tokens', await view(1, { name, token }))
  })

  app.post('/tokens/:id/delete', { schema: { params: TokenParams } }, async (request, reply) => {
    await app.services.tokens.revoke(request.params.id)

    return reply.redirect('/tokens')
  })
}
