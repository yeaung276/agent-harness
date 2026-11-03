import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import fp from 'fastify-plugin'
import { Pool } from 'pg'

import * as schema from '../db/schema.ts'
import type { Db } from '../db/type.ts'

declare module 'fastify' {
  interface FastifyInstance {
    db: Db
  }
}

export const db = fp<{ migrationsFolder: string }>(
  async (app, { migrationsFolder }) => {
    const pool = new Pool({ connectionString: app.config.DATABASE_URL })
    // An idle client that loses its connection emits here; left unhandled, it crashes the process.
    pool.on('error', err => app.log.error(err, 'postgres pool error'))

    app.decorate('db', drizzle({ client: pool, schema }))
    app.addHook('onClose', () => pool.end())

    if (app.config.APP_MODE === 'server' && app.config.NODE_ENV === 'production') {
      // the log goes where the tables go: the first schema in the login's search_path
      const { rows } = await pool.query<{ schema: string }>('select current_schema() as schema')
      await migrate(app.db, { migrationsFolder, migrationsSchema: rows[0]!.schema })
    }
  },
  { name: 'db' }
)
