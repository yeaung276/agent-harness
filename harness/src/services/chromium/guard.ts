import { lookup } from 'node:dns/promises'
import { BlockList, isIP, isIPv6 } from 'node:net'

import type { BrowserContext } from 'playwright-core'

import { logger } from '../../logger.ts'

const log = logger('browser-guard')

const privateAddresses = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  privateAddresses.addSubnet(address, prefix, 'ipv4')
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  privateAddresses.addSubnet(address, prefix, 'ipv6')
}

const loopback = new BlockList()
loopback.addSubnet('127.0.0.0', 8, 'ipv4')
loopback.addAddress('::1', 'ipv6')

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 }
const DNS_TTL_MS = 10_000

const resolved = new Map<string, { addresses: string[]; expires: number }>()

const family = (address: string) => (isIPv6(address) ? 'ipv6' : 'ipv4')

const resolve = async (hostname: string) => {
  const bare = hostname.replace(/^\[(.*)\]$/, '$1')
  if (isIP(bare)) return [bare]

  const hit = resolved.get(bare)
  if (hit && hit.expires > Date.now()) return hit.addresses

  const addresses = await lookup(bare, { all: true, verbatim: true }).then(
    entries => entries.map(entry => entry.address),
    () => []
  )
  resolved.set(bare, { addresses, expires: Date.now() + DNS_TTL_MS })

  return addresses
}

export const isAllowed = async (raw: string, workspaceAccessPort?: number | null) => {
  if (!URL.canParse(raw)) return false

  const url = new URL(raw)
  const defaultPort = DEFAULT_PORTS[url.protocol]
  if (defaultPort === undefined) return false

  const addresses = await resolve(url.hostname)
  if (addresses.length === 0) return false
  if (addresses.every(address => !privateAddresses.check(address, family(address)))) return true

  const port = url.port === '' ? defaultPort : Number(url.port)

  return port === workspaceAccessPort && addresses.every(address => loopback.check(address, family(address)))
}

export const guard = async (context: BrowserContext, getWorkspaceAccessPort?: () => number | null) => {
  await context.route('**/*', async route => {
    const allowed = await isAllowed(route.request().url(), getWorkspaceAccessPort?.())
    log.debug({ url: route.request().url(), allowed }, 'browser request checked against the network rule')

    await (allowed ? route.continue() : route.abort('blockedbyclient')).catch(() => undefined)
  })

  await context.routeWebSocket(
    () => true,
    async ws => {
      const allowed = await isAllowed(ws.url(), getWorkspaceAccessPort?.())
      log.info({ url: ws.url(), allowed }, 'browser websocket checked against the network rule')
      if (allowed) ws.connectToServer()
      else await ws.close({ code: 1008, reason: 'blocked' }).catch(() => undefined)
    }
  )
}
