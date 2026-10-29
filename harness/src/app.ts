import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import Fastify, { type FastifyServerOptions } from 'fastify'

import type { Config } from './config.ts'
import { bindLogger } from './logger.ts'
import { chromium } from './plugins/chromium.ts'
import { db } from './plugins/db.ts'
import { logStream } from './plugins/log-stream.ts'
import { multipart } from './plugins/multipart.ts'
import { redis } from './plugins/redis.ts'
import { sandbox } from './plugins/sandbox.ts'
import { services } from './plugins/services.ts'
import { workers } from './plugins/workers.ts'
import { api } from './routes/api/index.ts'
import { mcp } from './routes/mcp/index.ts'
import { web } from './routes/web/index.ts'
import { workerRoutes } from './routes/workers/index.ts'
import { registerWithServer } from './services/workers/registration.ts'

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
  const worker = config.APP_MODE === 'worker'
  const registration = worker && config.NODE_ENV !== 'development' ? await registerWithServer(config) : null
  const app = Fastify({
    logger: logger(config),
    https: registration?.https ?? null,
  }).withTypeProvider<TypeBoxTypeProvider>()
  bindLogger(app.log)

  app.decorate('config', config)
  await app.register(db)
  await app.register(redis)
  await app.register(services)

  if (worker) {
    await app.register(logStream)
    await app.register(sandbox)
    await app.register(chromium)
    if (registration) await app.register(registration.statsReporter)
    return app
  }

  await app.register(workers)
  await app.register(multipart)

  await app.register(api, { prefix: '/api/v1' })
  await app.register(mcp, { prefix: '/mcp' })
  await app.register(workerRoutes, { prefix: '/workers' })
  await app.register(web)

  return app
}
