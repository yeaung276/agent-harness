import { lookup } from 'node:dns/promises'
import { once } from 'node:events'
import { type AddressInfo, BlockList, connect, createServer } from 'node:net'
import { pipeline } from 'node:stream'

import { logger } from '../../logger.ts'

const log = logger('network-controller')

export const PROXY_PORT = 3128

export const PROXY_ENV = {
  HTTP_PROXY: `http://127.0.0.1:${PROXY_PORT}`,
  HTTPS_PROXY: `http://127.0.0.1:${PROXY_PORT}`,
  http_proxy: `http://127.0.0.1:${PROXY_PORT}`,
  https_proxy: `http://127.0.0.1:${PROXY_PORT}`,
  NO_PROXY: 'localhost,127.0.0.1',
  no_proxy: 'localhost,127.0.0.1',
  NODE_USE_ENV_PROXY: '1',
}

const privateAddresses = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  privateAddresses.addSubnet(address, prefix)
}

const matchesAny = (host: string, patterns: string[]) =>
  patterns.some(pattern => {
    const name = pattern.toLowerCase()
    return name === '*' || name === host || (name.startsWith('*.') && host.endsWith(name.slice(1)))
  })

export type NetworkRules = { allow?: string[]; deny?: string[] }

export const createNetworkController = ({ allow = [], deny = [] }: NetworkRules) => {
  const server = createServer(client => {
    let head = Buffer.alloc(0)

    const read = async (chunk: Buffer) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) {
        if (head.length > 64 * 1024) client.destroy()
        return
      }

      client.off('data', read)
      client.pause()

      const [method, target = ''] = head.toString('latin1', 0, head.indexOf('\r\n')).split(' ')
      try {
        const url = new URL(method === 'CONNECT' ? `http://${target}` : target)
        const host = url.hostname.replace(/\.$/, '')
        if (matchesAny(host, deny) && !matchesAny(host, allow)) {
          log.info({ method, target }, 'sandbox internet request denied by its deny list')
          client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
          return
        }

        const { address, family } = await lookup(host, { family: 4 })
        if (family !== 4 || privateAddresses.check(address)) {
          log.warn({ method, target, address }, 'sandbox internet request refused: host resolves to a private address')
          client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
          return
        }

        const upstream = connect(Number(url.port) || 80, address)
        await once(upstream, 'connect')
        log.debug({ method, target }, 'sandbox internet request allowed')

        if (method === 'CONNECT') {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        } else {
          const kept = head
            .toString('latin1', 0, end)
            .split('\r\n')
            .filter(line => !/^(proxy-)?connection:/i.test(line))
          upstream.write(`${kept.join('\r\n')}\r\nConnection: close\r\n\r\n`, 'latin1')
        }
        upstream.write(head.subarray(end + 4))
        pipeline(client, upstream, client, () => {})
      } catch (err) {
        log.info({ method, target, err }, 'sandbox internet request failed: bad target, DNS or connect error')
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      }
    }

    client.on('data', read)
    client.on('error', () => {})
  })

  server.listen(0, '127.0.0.1')

  return {
    port: (server.address() as AddressInfo).port,
    close: () => server.close(),
  }
}
