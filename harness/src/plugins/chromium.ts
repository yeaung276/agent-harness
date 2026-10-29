import fp from 'fastify-plugin'

import { createChromiumManager } from '../services/chromium/manager.ts'
import { chromiumRoutes } from '../services/chromium/routes/index.ts'
import { sweeper } from '../services/sandbox/sweeper.ts'

declare module 'fastify' {
  interface FastifyInstance {
    chromium: ReturnType<typeof createChromiumManager>
  }
}

export const chromium = fp(
  async app => {
    const manager = createChromiumManager({
      workspaces: app.services.workspaces,
      sandboxes: app.sandbox,
      browsers: app.services.browsers,
      activities: app.services.browserActivities,
      placement: app.services.placement,
      mode: app.config.SANDBOX_MODE,
      portMin: app.config.SANDBOX_PORT_MIN,
      portMax: app.config.SANDBOX_PORT_MAX,
      idleMs: app.config.BROWSER_IDLE_MS,
    })
    app.decorate('chromium', manager)
    await manager.start()

    await app.register(chromiumRoutes, { prefix: '/internal/chromium' })

    const idle = sweeper(manager)
    idle.start()

    app.addHook('onClose', async () => {
      idle.stop()
      await manager.stopAll()
    })
  },
  { name: 'chromium', dependencies: ['services', 'sandbox'] }
)
