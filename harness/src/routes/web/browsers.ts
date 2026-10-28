import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'

export const browsers: FastifyPluginAsyncTypebox = async app => {
  app.get('/browsers', async (_request, reply) => reply.viewAsync('browsers', { title: 'Browsers', active: 'browsers' }))
}
