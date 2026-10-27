import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

import { createTokenService } from '../services/tokens/index.ts'
import { createWorkspaceService } from '../services/workspaces/index.ts'

const createServices = (app: FastifyInstance) => ({
  tokens: createTokenService({ db: app.db }),
  workspaces: createWorkspaceService({
    db: app.db,
    dir: app.config.WORKSPACES_DIR,
    depsRoot: app.config.SANDBOX_DEPS_ROOT,
    dataEncryptionKey: app.config.DATA_ENCRYPTION_KEY,
    log: app.log,
  }),
})

declare module 'fastify' {
  interface FastifyInstance {
    services: ReturnType<typeof createServices>
  }
}

export const services = fp(
  async app => {
    app.decorate('services', createServices(app))

    app.addHook('onReady', async () => {
      void app.services.workspaces.removeLeftovers()
    })
  },
  { name: 'services', dependencies: ['db', 'redis'] }
)
