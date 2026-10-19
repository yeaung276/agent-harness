import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

import { createTokenService } from '../services/tokens/index.ts'

const createServices = (app: FastifyInstance) => ({
  tokens: createTokenService({ db: app.db }),
})

declare module 'fastify' {
  interface FastifyInstance {
    services: ReturnType<typeof createServices>
  }
}

// builds every service once and puts them on app.services
export const services = fp(
  async app => {
    app.decorate('services', createServices(app))
  },
  { name: 'services', dependencies: ['db', 'redis'] }
)
