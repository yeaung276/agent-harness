import { join } from 'node:path'

import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

import { loadConfig } from '../src/config.ts'

const pool = new Pool({ connectionString: loadConfig().DATABASE_URL })

try {
  // the log goes where the tables go: the first schema in the login's search_path
  const { rows } = await pool.query<{ schema: string }>('select current_schema() as schema')
  await migrate(drizzle({ client: pool }), {
    migrationsFolder: join(import.meta.dirname, '..', 'drizzle'),
    migrationsSchema: rows[0]!.schema,
  })
} finally {
  await pool.end()
}
