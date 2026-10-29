import { desc, eq } from 'drizzle-orm'

import { browserActivities } from '../../db/schema.ts'
import type { Db } from '../../db/type.ts'
import type { PageContent } from '../chromium/ops.ts'
import { WORKSPACE_ORIGIN } from '../chromium/session.ts'

type Kind = (typeof browserActivities.kind.enumValues)[number]

// one line on what a call returned, not the result itself
const summary = (kind: Kind, result: unknown) => {
  if (kind === 'run') return (JSON.stringify(result) ?? 'undefined').slice(0, 200)
  if (kind === 'screenshot') return 'saved'
  const page = result as PageContent
  return `${page.title} · ${page.url.replace(WORKSPACE_ORIGIN, '')}`
}

export const createBrowserActivityService = ({ db }: { db: Db }) => ({
  record: async (
    browserId: string,
    kind: Kind,
    command: string,
    { result, error }: { result: unknown; error: string | null }
  ) => {
    await db.insert(browserActivities).values({
      browserId,
      kind,
      command,
      status: error === null ? 'succeeded' : 'failed',
      output: error ?? summary(kind, result),
    })
  },

  // a browser's calls, newest first, one page at a time
  list: async (browserId: string, { limit, offset }: { limit: number; offset: number }) => {
    const [items, total] = await Promise.all([
      db
        .select({
          id: browserActivities.id,
          kind: browserActivities.kind,
          command: browserActivities.command,
          status: browserActivities.status,
          output: browserActivities.output,
          createdAt: browserActivities.createdAt,
        })
        .from(browserActivities)
        .where(eq(browserActivities.browserId, browserId))
        .orderBy(desc(browserActivities.createdAt), desc(browserActivities.id))
        .limit(limit)
        .offset(offset),
      db.$count(browserActivities, eq(browserActivities.browserId, browserId)),
    ])
    return { items, total }
  },
})
