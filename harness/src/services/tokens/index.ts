import { createHash, randomBytes } from 'node:crypto'

import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'

import { apiTokens, users } from '../../db/schema.ts'
import type { Db } from '../../db/type.ts'
import { logger } from '../../logger.ts'

const log = logger('tokens-service')

const PREFIX = 'pat_'
const DAY_MS = 24 * 60 * 60 * 1000

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

export const createTokenService = ({ db }: { db: Db }) => ({
  // returns the token itself; only its hash is stored, so it can't be shown again
  create: async (userId: string, { name, expiresInDays }: { name: string; expiresInDays: number | null }) => {
    const token = PREFIX + randomBytes(32).toString('base64url')
    await db.insert(apiTokens).values({
      userId,
      name,
      tokenHash: hash(token),
      tokenStart: token.slice(0, PREFIX.length + 4),
      expiresAt: expiresInDays === null ? null : new Date(Date.now() + expiresInDays * DAY_MS),
    })
    log.info({ userId, name, tokenStart: token.slice(0, PREFIX.length + 4), expiresInDays }, 'api token created')
    return token
  },

  // every user's tokens, newest first, one page at a time
  list: async ({ limit, offset }: { limit: number; offset: number }) => {
    const [items, total] = await Promise.all([
      db
        .select({
          id: apiTokens.id,
          name: apiTokens.name,
          tokenStart: apiTokens.tokenStart,
          createdBy: users.email,
          expiresAt: apiTokens.expiresAt,
          lastUsedAt: apiTokens.lastUsedAt,
          createdAt: apiTokens.createdAt,
        })
        .from(apiTokens)
        .innerJoin(users, eq(users.id, apiTokens.userId))
        .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id))
        .limit(limit)
        .offset(offset),
      db.$count(apiTokens),
    ])
    return { items, total }
  },

  revoke: async (id: string) => {
    await db.delete(apiTokens).where(eq(apiTokens.id, id))
    log.info({ tokenId: id }, 'api token revoked')
  },

  // the user an unexpired token belongs to, or null
  verify: async (token: string) => {
    const tokenHash = hash(token)
    const [row] = await db
      .select({ userId: apiTokens.userId })
      .from(apiTokens)
      .where(
        and(eq(apiTokens.tokenHash, tokenHash), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, sql`now()`)))
      )
    if (!row) return null

    // at most one write a minute per token, not one per call
    await db
      .update(apiTokens)
      .set({ lastUsedAt: sql`now()` })
      .where(
        and(
          eq(apiTokens.tokenHash, tokenHash),
          or(isNull(apiTokens.lastUsedAt), lt(apiTokens.lastUsedAt, sql`now() - interval '1 minute'`))
        )
      )

    return row.userId
  },
})
