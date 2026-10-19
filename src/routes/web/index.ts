import { join } from 'node:path'

import fastifyCookie from '@fastify/cookie'
import fastifyFormbody from '@fastify/formbody'
import fastifyStatic from '@fastify/static'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import fastifyView from '@fastify/view'
import { Eta } from 'eta'

import { auth, requireSession } from './auth.ts'
import { health } from './health.ts'
import { tokens } from './tokens.ts'
import { workspaces } from './workspaces.ts'

export const web: FastifyPluginAsyncTypebox = async app => {
  await app.register(fastifyView, {
    engine: { eta: new Eta() },
    root: join(import.meta.dirname, 'views'),
    production: app.config.NODE_ENV === 'production',
  })
  await app.register(fastifyStatic, { root: join(import.meta.dirname, 'public'), prefix: '/public/' })
  await app.register(fastifyCookie)
  await app.register(fastifyFormbody)

  await app.register(health)
  await app.register(auth)

  await app.register(async pages => {
    await pages.register(requireSession)

    pages.get('/', async (_request, reply) => reply.redirect('/workspaces'))
    await pages.register(workspaces)
    await pages.register(tokens)
  })
}
