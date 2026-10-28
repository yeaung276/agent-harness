import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

import { createActivityService } from '../services/activities/index.ts'
import { createBrowserSessionService } from '../services/browser-sessions/index.ts'
import { createTokenService } from '../services/tokens/index.ts'
import { createWorkspaceService } from '../services/workspaces/index.ts'

const createServices = (app: FastifyInstance) => ({
  activities: createActivityService({ db: app.db }),
  browserSessions: createBrowserSessionService({ db: app.db }),
  tokens: createTokenService({ db: app.db }),
  workspaces: createWorkspaceService({
    db: app.db,
    dir: app.config.WORKSPACES_DIR,
    depsRoot: app.config.SANDBOX_DEPS_ROOT,
    dataEncryptionKey: app.config.DATA_ENCRYPTION_KEY,
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
