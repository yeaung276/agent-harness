import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import Fastify, { type FastifyServerOptions } from 'fastify'

import type { Config } from './config.ts'
import { db } from './plugins/db.ts'
import { multipart } from './plugins/multipart.ts'
import { redis } from './plugins/redis.ts'
import { services } from './plugins/services.ts'
import { api } from './routes/api/index.ts'
import { mcp } from './routes/mcp/index.ts'
import { web } from './routes/web/index.ts'

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
  }
}

const logger = ({ NODE_ENV, LOG_LEVEL }: Config): FastifyServerOptions['logger'] =>
  NODE_ENV === 'development'
    ? {
        level: LOG_LEVEL,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname', singleLine: true },
        },
      }
    : { level: LOG_LEVEL }

export const buildApp = async (config: Config) => {
  const app = Fastify({ logger: logger(config) }).withTypeProvider<TypeBoxTypeProvider>()

  app.decorate('config', config)
  await app.register(db)
  await app.register(redis)
  await app.register(services)
  await app.register(multipart)

  await app.register(api, { prefix: '/api/v1' })
  await app.register(mcp, { prefix: '/mcp' })
  await app.register(web)

  return app
}
