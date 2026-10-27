import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'

import type { createSandboxManager } from '../../../src/services/sandbox/manager.ts'
import { portForwarder, WORKSPACE_APP_HEADER } from '../../../src/services/sandbox/port-forwarder.ts'
import type { SandboxStatus } from '../../../src/services/sandbox/sandbox.ts'

const WORKSPACE_ID = 'ws-1'

type Seen = { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }

let devServer: http.Server
let devPort: number
let front: http.Server
let frontPort: number
let seen: Seen[]
let uses: number
let releases: number

const launch = (status: SandboxStatus, hostPort: number | null = devPort) => ({
  status: () => status,
  hostPort,
  use: () => {
    uses++
    let released = false
    return () => {
      if (released) return
      released = true
      releases++
    }
  },
})

let wake: ReturnType<typeof mock<(workspaceId: string) => Promise<ReturnType<typeof launch> | null>>>

const listen = (server: http.Server): Promise<number> =>
  new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

const send = (
  opts: { method?: string; path?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: frontPort,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers: { [WORKSPACE_APP_HEADER]: WORKSPACE_ID, ...opts.headers },
      },
      res => {
        let body = ''
        res.on('data', d => (body += d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      }
    )
    req.on('error', reject)
    req.end(opts.body)
  })

const openSocket = (headers: Record<string, string>): Promise<{ socket: net.Socket; response: string }> =>
  new Promise(resolve => {
    const socket = net.connect(frontPort, '127.0.0.1', () => {
      const lines = Object.entries({
        Host: 'proxy.example.com',
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        ...headers,
      }).map(([k, v]) => `${k}: ${v}`)
      socket.write(`GET /live HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`)
    })
    socket.once('data', d => resolve({ socket, response: d.toString() }))
  })

beforeEach(async () => {
  seen = []
  uses = 0
  releases = 0

  devServer = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => (body += d))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      const delay = req.url === '/slow' ? 150 : 0
      setTimeout(() => {
        res.writeHead(201, { 'set-cookie': 'sid=abc; Path=/', 'x-app': 'yes' })
        res.end(`app got ${req.method} ${req.url} ${body}`)
      }, delay)
    })
  })
  devServer.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', d => socket.write(d))
    socket.on('end', () => socket.end())
  })
  devPort = await listen(devServer)

  wake = mock(async () => launch('running'))
  const forwarder = portForwarder({ wake } as unknown as ReturnType<typeof createSandboxManager>)

  // as the plugin wires it: marked requests and upgrades go to the forwarder, the rest to the API
  front = http.createServer((req, res) => {
    const workspaceId = forwarder.workspaceIdOf(req)
    if (workspaceId === null) return void res.end('internal api')
    void forwarder.request(req, res, workspaceId)
  })
  front.on('upgrade', (req, socket, head) => {
    const workspaceId = forwarder.workspaceIdOf(req)
    if (workspaceId === null) return void socket.destroy()
    void forwarder.upgrade(req, socket, head, workspaceId)
  })
  frontPort = await listen(front)
})

afterEach(async () => {
  front.closeAllConnections()
  devServer.closeAllConnections()
  await new Promise(r => front.close(r))
  await new Promise(r => devServer.close(r))
})

describe('port forwarder', () => {
  test("passes the request and the workspace's response through unchanged", async () => {
    const res = await send({
      method: 'POST',
      path: '/notes?draft=1',
      body: 'hello',
      headers: { cookie: 'sid=abc', 'content-type': 'text/plain' },
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/notes?draft=1', body: 'hello' })
    expect(seen[0]?.headers.cookie).toBe('sid=abc')
    expect(res.status).toBe(201)
    expect(res.headers['set-cookie']).toEqual(['sid=abc; Path=/'])
    expect(res.headers['x-app']).toBe('yes')
    expect(res.body).toBe('app got POST /notes?draft=1 hello')
    expect(wake).toHaveBeenCalledWith(WORKSPACE_ID)
  })

  test('sends a marked request to the workspace even on an internal API path, and leaves unmarked ones to the API', async () => {
    const marked = await send({ method: 'POST', path: '/internal/sandbox/exec' })
    const unmarked = await new Promise<string>(resolve =>
      http.get({ host: '127.0.0.1', port: frontPort, path: '/internal/sandbox/exec' }, res => {
        let body = ''
        res.on('data', d => (body += d))
        res.on('end', () => resolve(body))
      })
    )

    expect(marked.body).toBe('app got POST /internal/sandbox/exec ')
    expect(unmarked).toBe('internal api')
  })

  test('holds the request while a stopped workspace wakes, then serves it', async () => {
    wake.mockImplementation(() => new Promise(r => setTimeout(() => r(launch('running')), 200)))

    const res = await send({ path: '/' })

    expect(res.status).toBe(201)
    expect(res.body).toBe('app got GET / ')
  })

  test("answers with the workspace's state when it can't be served", async () => {
    wake.mockResolvedValueOnce(launch('failed', null))
    const failed = await send()

    wake.mockResolvedValueOnce(launch('starting'))
    const starting = await send()

    wake.mockResolvedValueOnce(null)
    const stopped = await send()

    expect([failed.status, failed.body, failed.headers['retry-after']]).toEqual([502, 'workspace failed', undefined])
    expect([starting.status, starting.body, starting.headers['retry-after']]).toEqual([
      503,
      'workspace is starting',
      '5',
    ])
    expect([stopped.status, stopped.body, stopped.headers['retry-after']]).toEqual([503, 'workspace is stopped', '5'])
    expect(seen).toHaveLength(0)
    expect(uses).toBe(0)
  })

  test('holds the workspace in use until the response is done', async () => {
    const pending = send({ path: '/slow' })
    await new Promise(r => setTimeout(r, 75))

    expect([uses, releases]).toEqual([1, 0])
    await pending
    await new Promise(r => setTimeout(r, 10))
    expect([uses, releases]).toEqual([1, 1])
  })

  test('answers 502 when the dev server is gone', async () => {
    wake.mockResolvedValueOnce(launch('running', 1))

    const res = await send()

    expect(res.status).toBe(502)
    expect(res.body).toMatch(/workspace unreachable/)
  })

  test('pipes a WebSocket both ways and holds the workspace in use while it is open', async () => {
    const { socket, response } = await openSocket({ [WORKSPACE_APP_HEADER]: WORKSPACE_ID })
    expect(response).toMatch(/^HTTP\/1.1 101/)

    const echoed = new Promise<string>(resolve => socket.once('data', d => resolve(d.toString())))
    socket.write('ping')
    expect(await echoed).toBe('ping')
    expect([uses, releases]).toEqual([1, 0])

    socket.destroy()
    await new Promise(r => setTimeout(r, 50))
    expect(releases).toBe(1)
  })

  test("refuses a WebSocket for a workspace that isn't running", async () => {
    wake.mockResolvedValueOnce(launch('starting'))

    const { socket, response } = await openSocket({ [WORKSPACE_APP_HEADER]: WORKSPACE_ID })
    socket.destroy()

    expect(response).toMatch(/^HTTP\/1.1 503/)
    expect(uses).toBe(0)
  })
})
