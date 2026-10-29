import http from 'node:http'
import type { AddressInfo } from 'node:net'

import fp from 'fastify-plugin'

import { VIEW_PATH, createProxy } from '../services/proxy/index.ts'

declare module 'fastify' {
  interface FastifyInstance {
    proxy: { server: http.Server; urlOf: (workspaceId: string) => string }
  }
}

export const proxy = fp(
  async app => {
    const service = createProxy({
      workspaces: app.services.workspaces,
      placement: app.services.placement,
      workers: app.workers,
      proxyUrl: app.config.PROXY_URL,
      proxyMode: app.config.PROXY_MODE,
      tokenSecret: app.config.PROXY_TOKEN_SECRET,
    })

    const server = http.createServer((req, res) => {
      if (app.config.PROXY_MODE === 'cookie' && req.url?.split('?')[0] === VIEW_PATH) return service.view(req, res)
      void service.request(req, res).catch(err => {
        app.log.error({ err }, 'proxy request failed')
        res.destroy()
      })
    })
    server.on('upgrade', (req, socket, head) => {
      void service.upgrade(req, socket, head).catch(err => {
        app.log.error({ err }, 'proxy upgrade failed')
        socket.destroy()
      })
    })
    app.decorate('proxy', { server, urlOf: service.urlOf })

    app.addHook('onListen', async () => {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(app.config.PROXY_PORT, app.config.HOST, resolve)
      })
      app.log.info({ port: (server.address() as AddressInfo).port }, 'proxy listening')
    })

    app.addHook('onClose', async () => {
      if (!server.listening) return
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    })
  },
  { name: 'proxy', dependencies: ['services'] }
)
