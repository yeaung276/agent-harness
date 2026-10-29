import { createHmac, timingSafeEqual } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { type Duplex, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import tls from 'node:tls'

import { logger } from '../../logger.ts'
import { HttpError } from '../http-error.ts'
import type { createPlacementService } from '../placement/index.ts'
import { WORKSPACE_APP_HEADER } from '../sandbox/port-forwarder.ts'
import type { createWorkerService } from '../workers/index.ts'
import type { createWorkspaceService } from '../workspaces/index.ts'

const log = logger('proxy')

export const VIEW_PATH = '/__view'
const VIEW_COOKIE = 'workspace_view'
const VIEW_TOKEN_TTL_MS = 60 * 1000
const VIEW_COOKIE_TTL_S = 12 * 60 * 60
const SOCKET_RENEW_MS = 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export const createProxy = ({
  workspaces,
  placement,
  workers,
  proxyUrl,
  proxyMode,
  tokenSecret,
}: {
  workspaces: ReturnType<typeof createWorkspaceService>
  placement: ReturnType<typeof createPlacementService>
  workers: Awaited<ReturnType<typeof createWorkerService>>
  proxyUrl: string
  proxyMode: 'subdomain' | 'cookie'
  tokenSecret: string | undefined
}) => {
  if (proxyMode === 'cookie' && !tokenSecret) throw new Error('PROXY_TOKEN_SECRET is required in the cookie mode')

  const base = new URL(proxyUrl)
  const sessions = new Map<string, Bun.FetchSession>()

  const signatureOf = (payload: string) => createHmac('sha256', tokenSecret!).update(payload).digest()

  const sign = (workspaceId: string, ttlMs: number) => {
    const payload = `${workspaceId}.${Date.now() + ttlMs}`
    return `${payload}.${signatureOf(payload).toString('base64url')}`
  }

  const verify = (token: string) => {
    const [workspaceId, expiresAt, signature] = token.split('.')
    if (!workspaceId || !expiresAt || !signature || Number(expiresAt) < Date.now()) return null
    const given = Buffer.from(signature, 'base64url')
    const expected = signatureOf(`${workspaceId}.${expiresAt}`)
    return given.length === expected.length && timingSafeEqual(given, expected) ? workspaceId : null
  }

  const workspaceIdFromReq = (req: IncomingMessage) => {
    if (proxyMode === 'cookie') {
      const cookie = new Bun.CookieMap(req.headers.cookie ?? '').get(VIEW_COOKIE)
      const workspaceId = cookie ? verify(cookie) : null
      if (!workspaceId) throw new HttpError(403, 'The workspace cookie is missing or expired')
      return workspaceId
    }

    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase()
    const suffix = `.${base.hostname}`
    const label = host.endsWith(suffix) ? host.slice(0, -suffix.length) : ''
    if (!UUID.test(label)) throw new HttpError(404, 'No workspace at this host')
    return label
  }

  const sessionOf = (worker: string, tls: Awaited<ReturnType<typeof workers.getConnectionInfo>>['tls']) => {
    let session = sessions.get(worker)
    if (!session) {
      session = new Bun.FetchSession({ tls })
      sessions.set(worker, session)
    }
    return session
  }

  const target = async (req: IncomingMessage) => {
    const workspaceId = workspaceIdFromReq(req)

    const worker = await placement.workspace(workspaceId, 'running').catch(async err => {
      if (!(err instanceof HttpError) || err.status !== 409) throw err
      await workspaces.get(workspaceId)
      return placement.workspace(workspaceId, 'any')
    })
    return { workspaceId, worker, connection: await workers.getConnectionInfo(worker) }
  }

  const answer = (res: ServerResponse, err: HttpError) => {
    const retry = err.status === 503 ? { 'retry-after': '5' } : {}
    res.writeHead(err.status, { 'content-type': 'text/plain; charset=utf-8', ...retry })
    res.end(err.message)
  }

  return {
    urlOf: (workspaceId: string) =>
      proxyMode === 'cookie'
        ? `${base.origin}${VIEW_PATH}?token=${sign(workspaceId, VIEW_TOKEN_TTL_MS)}`
        : `${base.protocol}//${workspaceId}.${base.host}/`,

    view: (req: IncomingMessage, res: ServerResponse) => {
      const token = new URL(req.url ?? '/', base).searchParams.get('token')
      const workspaceId = token ? verify(token) : null
      if (!workspaceId) return answer(res, new HttpError(403, 'The view link is invalid or expired'))

      const cookie = `${VIEW_COOKIE}=${sign(workspaceId, VIEW_COOKIE_TTL_S * 1000)}`
      res.writeHead(302, {
        location: '/',
        'set-cookie': `${cookie}; Max-Age=${VIEW_COOKIE_TTL_S}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`,
      })
      res.end()
    },

    request: async (req: IncomingMessage, res: ServerResponse) => {
      const found = await target(req).catch(err => {
        if (!(err instanceof HttpError)) throw err
        answer(res, err)
        return null
      })
      if (!found) return
      const { workspaceId, worker, connection } = found

      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name) || name === WORKSPACE_APP_HEADER) continue
        for (const each of [value].flat()) headers.append(name, each)
      }
      headers.set(WORKSPACE_APP_HEADER, workspaceId)

      const left = new AbortController()
      res.once('close', () => left.abort())

      const upstream = await sessionOf(worker, connection.tls)
        .fetch(`https://${connection.address}${req.url}`, {
          method: req.method,
          headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : (Readable.toWeb(req) as ReadableStream),
          duplex: 'half',
          redirect: 'manual',
          decompress: false,
          signal: left.signal,
        })
        .catch(err => {
          if (left.signal.aborted) return null
          log.warn({ workspaceId, worker, err }, 'worker unreachable')
          answer(res, new HttpError(503, `worker ${worker} can't be reached`))
          return null
        })
      if (!upstream) return

      const out: Record<string, string | string[]> = {}
      upstream.headers.forEach((value, name) => {
        if (!HOP_BY_HOP.has(name) && name !== 'set-cookie') out[name] = value
      })
      const cookies = upstream.headers.getSetCookie()
      if (cookies.length > 0) out['set-cookie'] = cookies

      res.writeHead(upstream.status, out)
      if (!upstream.body) return void res.end()
      await pipeline(Readable.fromWeb(upstream.body as never), res).catch(() => {})
    },

    upgrade: async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const found = await target(req).catch(err => {
        if (!(err instanceof HttpError)) throw err
        socket.end(`HTTP/1.1 ${err.status} ${http.STATUS_CODES[err.status]}\r\nconnection: close\r\n\r\n`)
        return null
      })
      if (!found) return
      const { workspaceId, worker, connection } = found

      const { hostname, port } = new URL(`https://${connection.address}`)
      const upstream = tls.connect({ host: hostname, port: Number(port), ...connection.tls }, () => {
        const headers = [`${WORKSPACE_APP_HEADER}: ${workspaceId}`]
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          if (req.rawHeaders[i]?.toLowerCase() === WORKSPACE_APP_HEADER) continue
          headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
        }

        upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`)
        if (head.length > 0) upstream.write(head)

        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      upstream.once('error', err => log.warn({ workspaceId, worker, err }, 'worker unreachable for a websocket'))

      const renew = setInterval(
        () =>
          void placement
            .workspace(workspaceId, 'running')
            .catch(err => log.warn({ workspaceId, worker, err }, 'placement renewal failed')),
        SOCKET_RENEW_MS
      )
      const close = () => {
        clearInterval(renew)
        upstream.destroy()
        socket.destroy()
      }
      for (const side of [upstream, socket]) for (const event of ['end', 'error', 'close']) side.once(event, close)
    },
  }
}
