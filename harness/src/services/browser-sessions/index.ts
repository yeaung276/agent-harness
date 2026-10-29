import { desc, eq } from 'drizzle-orm'

import { browserSessions, users } from '../../db/schema.ts'
import type { Db } from '../../db/type.ts'
import type { SessionState } from '../chromium/session.ts'

export const createBrowserSessionService = ({ db }: { db: Db }) => ({
  create: async (userId: string, { workspaceId, record }: { workspaceId: string | null; record: boolean }) => {
    const [row] = await db.insert(browserSessions).values({ userId, workspaceId, record }).returning()
    return row!
  },

  get: async (id: string) => {
    const [row] = await db.select().from(browserSessions).where(eq(browserSessions.id, id))
    return row ?? null
  },

  list: async ({ limit, offset }: { limit: number; offset: number }) => {
    const [items, total] = await Promise.all([
      db
        .select({
          id: browserSessions.id,
          status: browserSessions.status,
          workspaceId: browserSessions.workspaceId,
          url: browserSessions.url,
          record: browserSessions.record,
          createdBy: users.email,
          lastUsedAt: browserSessions.lastUsedAt,
          createdAt: browserSessions.createdAt,
        })
        .from(browserSessions)
        .innerJoin(users, eq(users.id, browserSessions.userId))
        .orderBy(desc(browserSessions.lastUsedAt), desc(browserSessions.createdAt), desc(browserSessions.id))
        .limit(limit)
        .offset(offset),
      db.$count(browserSessions),
    ])
    return { items, total }
  },

  update: async (id: string, { url, storageState, status }: Partial<SessionState & { status: 'alive' | 'closed' }>) => {
    await db
      .update(browserSessions)
      .set({ url, storageState, status, lastUsedAt: new Date() })
      .where(eq(browserSessions.id, id))
  },
})
