import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import Fastify, { type FastifyServerOptions } from 'fastify'

import { api } from './api/index.ts'
import type { Config } from './config.ts'
import { mcp } from './mcp/index.ts'
import { db } from './plugins/db.ts'
import { redis } from './plugins/redis.ts'
import { web } from './web/index.ts'

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
  }
}

const logger = ({ NODE_ENV, LOG_LEVEL }: Config): FastifyServerOptions['logger'] =>
  NODE_ENV === 'development'
    ? {
        level: LOG_LEVEL,
        transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } },
      }
    : { level: LOG_LEVEL }

export const buildApp = async (config: Config) => {
  const app = Fastify({ logger: logger(config) }).withTypeProvider<TypeBoxTypeProvider>()

  app.decorate('config', config)
  await app.register(db)
  await app.register(redis)

  await app.register(api, { prefix: '/api/v1' })
  await app.register(mcp, { prefix: '/mcp' })
  await app.register(web)

  return app
}
