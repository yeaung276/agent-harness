import { join } from 'node:path'

import fastifyStatic from '@fastify/static'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import fastifyView from '@fastify/view'
import { Eta } from 'eta'

import { health } from './health.ts'

export const web: FastifyPluginAsyncTypebox = async app => {
  await app.register(fastifyView, {
    engine: { eta: new Eta() },
    root: join(import.meta.dirname, 'views'),
    production: app.config.NODE_ENV === 'production',
  })
  await app.register(fastifyStatic, { root: join(import.meta.dirname, 'public'), prefix: '/public/' })

  await app.register(health)

  app.get('/', async (_request, reply) => reply.viewAsync('home', { title: 'code-harness' }))
}
