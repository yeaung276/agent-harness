import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'

import { createBrowserActivityService, createSandboxActivityService } from '../services/activities/index.ts'
import { createBrowserService } from '../services/browser/index.ts'
import { createPlacementService } from '../services/placement/index.ts'
import { createTokenService } from '../services/tokens/index.ts'
import { createWorkspaceService } from '../services/workspaces/index.ts'

const createServices = (app: FastifyInstance) => ({
  sandboxActivities: createSandboxActivityService({ db: app.db }),
  browserActivities: createBrowserActivityService({ db: app.db }),
  browsers: createBrowserService({ db: app.db }),
  placement: createPlacementService({
    redis: app.redis,
    workerName: app.config.WORKER_NAME,
    sandboxIdleMs: app.config.SANDBOX_IDLE_MS,
    browserIdleMs: app.config.BROWSER_IDLE_MS,
  }),
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
