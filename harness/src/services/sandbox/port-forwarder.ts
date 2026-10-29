import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'

import { logger } from '../../logger.ts'
import type { createSandboxManager } from './manager.ts'
import type { createSandbox } from './sandbox.ts'

const log = logger('port-forwarder')

export const WORKSPACE_APP_HEADER = 'x-workspace-app'

type Target = { launched: ReturnType<typeof createSandbox>; port: number } | { statusCode: number; message: string }

export const portForwarder = (manager: ReturnType<typeof createSandboxManager>) => {
  const target = async (workspaceId: string): Promise<Target> => {
    const launched = await manager.wake(workspaceId)
    if (!launched) return { statusCode: 503, message: 'workspace is stopped' }

    const status = launched.status()
    if (status === 'running' && launched.hostPort !== null) return { launched, port: launched.hostPort }
    if (status === 'failed') return { statusCode: 502, message: 'workspace failed' }

    return { statusCode: 503, message: `workspace is ${status}` }
  }

  return {
    // set by the preview proxy; a request without it is an internal API call
    workspaceIdOf: (req: IncomingMessage) => {
      const value = req.headers[WORKSPACE_APP_HEADER]

      return typeof value === 'string' && value.length > 0 ? value : null
    },

    request: async (req: IncomingMessage, res: ServerResponse, workspaceId: string) => {
      const startedAt = Date.now()
      res.once('close', () =>
        log.debug(
          {
            workspaceId,
            method: req.method,
            url: req.url,
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt,
          },
          'workspace app request forwarded'
        )
      )
      const found = await target(workspaceId)

      if (!('port' in found)) {
        const retry = found.statusCode === 503 ? { 'retry-after': '5' } : {}
        res.writeHead(found.statusCode, { 'content-type': 'text/plain; charset=utf-8', ...retry })
        res.end(found.message)
        return
      }

      res.once('close', found.launched.use())

      const upstream = http.request(
        { host: '127.0.0.1', port: found.port, method: req.method, path: req.url, headers: req.headers },
        upstreamRes => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
          upstreamRes.pipe(res)
        }
      )
      upstream.once('error', err => {
        log.warn({ workspaceId, port: found.port, err }, 'workspace app unreachable on its port')
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`workspace unreachable: ${err.message}`)
      })
      req.pipe(upstream)
    },

    upgrade: async (req: IncomingMessage, socket: Duplex, head: Buffer, workspaceId: string) => {
      const found = await target(workspaceId)

      if (!('port' in found)) {
        log.info({ workspaceId, url: req.url, statusCode: found.statusCode }, 'workspace app websocket refused')
        socket.end(`HTTP/1.1 ${found.statusCode} ${http.STATUS_CODES[found.statusCode]}\r\nconnection: close\r\n\r\n`)
        return
      }

      const release = found.launched.use()
      const upstream = net.connect(found.port, '127.0.0.1', () => {
        const headers = []
        for (let i = 0; i < req.rawHeaders.length; i += 2)
          headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)

        upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`)
        if (head.length > 0) upstream.write(head)

        upstream.pipe(socket)
        socket.pipe(upstream)
      })

      const close = () => {
        release()
        upstream.destroy()
        socket.destroy()
      }
      // either side ending ends both, so a half-closed peer can't hold the workspace in use
      for (const side of [upstream, socket]) for (const event of ['end', 'error', 'close']) side.once(event, close)
    },
  }
}
