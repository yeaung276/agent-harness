import fp from 'fastify-plugin'

declare module 'fastify' {
  interface FastifyRequest {
    userId: string
  }
}

// Routes registered alongside this need `Authorization: Bearer <token>`; without a valid one they answer 401.
export const requireToken = fp(
  async app => {
    app.decorateRequest('userId', '')
    app.addHook('onRequest', async (request, reply) => {
      const token = request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1]
      const userId = token ? await app.services.tokens.verify(token) : null
      if (!userId) return reply.status(401).header('WWW-Authenticate', 'Bearer').send({ error: 'Unauthorized' })

      request.userId = userId
    })
  },
  { name: 'require-token' }
)
