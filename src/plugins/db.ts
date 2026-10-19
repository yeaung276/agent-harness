import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import fp from 'fastify-plugin'
import { Pool } from 'pg'

import * as schema from '../db/schema.ts'

declare module 'fastify' {
  interface FastifyInstance {
    db: NodePgDatabase<typeof schema>
  }
}

export const db = fp(
  async app => {
    const pool = new Pool({ connectionString: app.config.DATABASE_URL })
    // An idle client that loses its connection emits here; left unhandled, it crashes the process.
    pool.on('error', err => app.log.error(err, 'postgres pool error'))

    app.decorate('db', drizzle({ client: pool, schema }))
    app.addHook('onClose', () => pool.end())
  },
  { name: 'db' }
)
