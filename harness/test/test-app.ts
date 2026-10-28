import { join } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import Fastify from 'fastify'
import fp from 'fastify-plugin'
import RedisMock from 'ioredis-mock'

import type { Config } from '../src/config.ts'
import * as schema from '../src/db/schema.ts'
import type { Db } from '../src/db/type.ts'
import { multipart } from '../src/plugins/multipart.ts'
import { sandbox } from '../src/plugins/sandbox.ts'
import { services } from '../src/plugins/services.ts'
import { api } from '../src/routes/api/index.ts'
import { mcp } from '../src/routes/mcp/index.ts'
import { web } from '../src/routes/web/index.ts'

export const buildTestApp = async (config: Config) => {
  const database = drizzle({ client: new PGlite(), schema })
  await migrate(database, { migrationsFolder: join(import.meta.dirname, '..', 'drizzle') })

  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>()
  app.decorate('config', config)
  await app.register(
    fp(
      async app => {
        app.decorate('db', database as unknown as Db)
        app.addHook('onClose', () => database.$client.close())
      },
      { name: 'db' }
    )
  )
  await app.register(
    fp(
      async app => {
        app.decorate('redis', new RedisMock())
      },
      { name: 'redis' }
    )
  )
  await app.register(services)

  if (config.APP_MODE === 'worker') {
    await app.register(sandbox)
    return app
  }

  await app.register(multipart)
  await app.register(api, { prefix: '/api/v1' })
  await app.register(mcp, { prefix: '/mcp' })
  await app.register(web)

  return app
}
