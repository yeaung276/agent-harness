import { randomBytes } from 'node:crypto'

import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

import { users } from '../../db/schema.ts'
import { LoginBody } from './schemas/auth.ts'

declare module 'fastify' {
  interface FastifyRequest {
    userId: string
  }
}

const COOKIE = 'sid'
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

const sessionKey = (id: string) => `session:${id}`

const sessionUserId = (app: FastifyInstance, request: FastifyRequest) => {
  const id = request.cookies[COOKIE]
  return id ? app.redis.get(sessionKey(id)) : null
}

export const auth: FastifyPluginAsyncTypebox = async app => {
  // checked when the email is unknown, so an unknown email takes as long as a wrong password
  const unknownUserHash = await Bun.password.hash(randomBytes(32).toString('hex'), 'argon2id')

  app.get('/login', async (request, reply) => {
    if (await sessionUserId(app, request)) return reply.redirect('/')

    return reply.viewAsync('login', { title: 'Log in', email: '', error: null })
  })

  app.post('/login', { schema: { body: LoginBody } }, async (request, reply) => {
    const email = request.body.email.trim().toLowerCase()
    const [user] = await app.db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, email))
    const valid = await Bun.password.verify(request.body.password, user?.passwordHash ?? unknownUserHash)
    if (!user || !valid) {
      return reply.status(401).viewAsync('login', { title: 'Log in', email, error: 'Wrong email or password.' })
    }

    const id = randomBytes(32).toString('base64url')
    await app.redis.set(sessionKey(id), user.id, 'EX', SESSION_TTL_SECONDS)

    return reply
      .setCookie(COOKIE, id, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_TTL_SECONDS,
        secure: app.config.NODE_ENV === 'production',
      })
      .redirect('/')
  })

  app.post('/logout', async (request, reply) => {
    const id = request.cookies[COOKIE]
    if (id) await app.redis.del(sessionKey(id))

    return reply.clearCookie(COOKIE, { path: '/' }).redirect('/login')
  })
}

// Routes registered alongside this need a session; without one they redirect to /login.
export const requireSession = fp(
  async app => {
    app.decorateRequest('userId', '')
    app.addHook('onRequest', async (request, reply) => {
      const userId = await sessionUserId(app, request)
      if (!userId) return reply.redirect('/login')

      request.userId = userId
    })
  },
  { name: 'require-session' }
)
