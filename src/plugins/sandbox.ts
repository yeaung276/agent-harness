import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import fp from 'fastify-plugin'

import { removeLeftoverLogs } from '../services/sandbox/log.ts'
import { createSandboxManager } from '../services/sandbox/manager.ts'
import { portForwarder } from '../services/sandbox/port-forwarder.ts'
import { sandboxRoutes } from '../services/sandbox/routes/index.ts'
import { assertSandboxUsable, setupCgroups } from '../services/sandbox/sandbox.ts'
import { sweeper } from '../services/sandbox/sweeper.ts'

declare module 'fastify' {
  interface FastifyInstance {
    sandbox: ReturnType<typeof createSandboxManager>
  }
}

export const sandbox = fp(
  async app => {
    if (app.config.APP_MODE !== 'worker') {
      throw new Error(`the sandbox plugin runs only with APP_MODE=worker (got '${app.config.APP_MODE}')`)
    }

    assertSandboxUsable(app.config)
    await setupCgroups(app.config.SANDBOX_MODE)
    await removeLeftoverLogs()

    const manager = createSandboxManager({
      workspaces: app.services.workspaces,
      activities: app.services.activities,
      mode: app.config.SANDBOX_MODE,
      memoryMaxMb: app.config.SANDBOX_MEMORY_MAX_MB,
      cpuMax: app.config.SANDBOX_CPU_MAX,
      pidsMax: app.config.SANDBOX_PIDS_MAX,
      portMin: app.config.SANDBOX_PORT_MIN,
      portMax: app.config.SANDBOX_PORT_MAX,
      idleMs: app.config.SANDBOX_IDLE_MS,
      depsRoot: app.config.SANDBOX_DEPS_ROOT,
    })
    app.decorate('sandbox', manager)

    // shares the internal API's port: a request the preview proxy marked with a workspace is app traffic, never an API call
    const forwarder = portForwarder(manager)

    app.addHook('onRequest', async (request, reply) => {
      const workspaceId = forwarder.workspaceIdOf(request.raw)
      if (workspaceId === null) return

      reply.hijack()
      await forwarder.request(request.raw, reply.raw, workspaceId).catch(err => {
        app.log.error({ workspaceId, err }, 'workspace forward failed')
        reply.raw.destroy()
      })
    })

    app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const workspaceId = forwarder.workspaceIdOf(req)
      if (workspaceId === null) return void socket.destroy()

      void forwarder.upgrade(req, socket, head, workspaceId).catch(err => {
        app.log.error({ workspaceId, err }, 'workspace upgrade failed')
        socket.destroy()
      })
    })

    await app.register(sandboxRoutes, { prefix: '/internal/sandbox' })

    const idle = sweeper(manager)
    idle.start()

    app.addHook('onClose', async () => {
      idle.stop()
      await manager.stopAll()
    })
  },
  { name: 'sandbox', dependencies: ['services'] }
)
