import { eq } from 'drizzle-orm'

import { browserSessions } from '../../db/schema.ts'
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

  update: async (
    id: string,
    { url, storageState, status }: Partial<SessionState & { status: 'alive' | 'closed' }>
  ) => {
    await db
      .update(browserSessions)
      .set({ url, storageState, status, lastUsedAt: new Date() })
      .where(eq(browserSessions.id, id))
  },})
