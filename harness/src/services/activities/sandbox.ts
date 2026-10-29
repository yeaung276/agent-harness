import { desc, eq } from 'drizzle-orm'

import { sandboxActivities } from '../../db/schema.ts'
import type { Db } from '../../db/type.ts'

export const createSandboxActivityService = ({ db }: { db: Db }) => ({
  record: async (
    workspaceId: string,
    kind: 'launch' | 'exec',
    command: string,
    { status, exitCode, output }: { status: 'succeeded' | 'failed'; exitCode: number | null; output: string }
  ) => {
    await db.insert(sandboxActivities).values({ workspaceId, kind, command, status, exitCode, output })
  },

  // a workspace's launches and execs, newest first, one page at a time
  list: async (workspaceId: string, { limit, offset }: { limit: number; offset: number }) => {
    const [items, total] = await Promise.all([
      db
        .select({
          id: sandboxActivities.id,
          kind: sandboxActivities.kind,
          command: sandboxActivities.command,
          status: sandboxActivities.status,
          exitCode: sandboxActivities.exitCode,
          output: sandboxActivities.output,
          createdAt: sandboxActivities.createdAt,
        })
        .from(sandboxActivities)
        .where(eq(sandboxActivities.workspaceId, workspaceId))
        .orderBy(desc(sandboxActivities.createdAt), desc(sandboxActivities.id))
        .limit(limit)
        .offset(offset),
      db.$count(sandboxActivities, eq(sandboxActivities.workspaceId, workspaceId)),
    ])
    return { items, total }
  },
})
