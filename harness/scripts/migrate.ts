import { join } from 'node:path'

import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

import { loadConfig } from '../src/config.ts'

const pool = new Pool({ connectionString: loadConfig().DATABASE_URL })

try {
  await migrate(drizzle({ client: pool }), { migrationsFolder: join(import.meta.dirname, '..', 'drizzle') })
} finally {
  await pool.end()
}
