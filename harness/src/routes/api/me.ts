import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { eq } from 'drizzle-orm'
import { Type } from 'typebox'

import { users } from '../../db/schema.ts'

const Me = Type.Object({ id: Type.String({ format: 'uuid' }), email: Type.String() })

export const me: FastifyPluginAsyncTypebox = async app => {
  app.get('/me', { schema: { response: { 200: Me } } }, async request => {
    const [user] = await app.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, request.userId))
    // a token is deleted with its user, so the user exists
    return user!
  })
}
