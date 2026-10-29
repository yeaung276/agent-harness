import { desc, eq } from 'drizzle-orm'

import { browsers, users } from '../../db/schema.ts'
import type { Db } from '../../db/type.ts'
import type { SessionState } from '../chromium/session.ts'

export const createBrowserService = ({ db }: { db: Db }) => ({
  create: async (userId: string, { workspaceId, record }: { workspaceId: string | null; record: boolean }) => {
    const [row] = await db.insert(browsers).values({ userId, workspaceId, record }).returning()
    return row!
  },

  get: async (id: string) => {
    const [row] = await db.select().from(browsers).where(eq(browsers.id, id))
    return row ?? null
  },

  list: async ({ limit, offset }: { limit: number; offset: number }) => {
    const [items, total] = await Promise.all([
      db
        .select({
          id: browsers.id,
          status: browsers.status,
          workspaceId: browsers.workspaceId,
          url: browsers.url,
          record: browsers.record,
          createdBy: users.email,
          lastUsedAt: browsers.lastUsedAt,
          createdAt: browsers.createdAt,
        })
        .from(browsers)
        .innerJoin(users, eq(users.id, browsers.userId))
        .orderBy(desc(browsers.lastUsedAt), desc(browsers.createdAt), desc(browsers.id))
        .limit(limit)
        .offset(offset),
      db.$count(browsers),
    ])
    return { items, total }
  },

  update: async (id: string, { url, storageState, status }: Partial<SessionState & { status: 'alive' | 'closed' }>) => {
    await db.update(browsers).set({ url, storageState, status, lastUsedAt: new Date() }).where(eq(browsers.id, id))
  },
})
