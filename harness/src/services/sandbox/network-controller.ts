import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { type AddressInfo, BlockList } from 'node:net'

import { Packet, UDPClient, createTCPServer, createUDPServer } from 'dns2'

import { logger } from '../../logger.ts'

const log = logger('network-controller')

export const DNS_PORT = 53

const UPSTREAM_TIMEOUT_MS = 5000

const resolvConf = existsSync('/etc/resolv.conf') ? readFileSync('/etc/resolv.conf', 'utf8') : ''
const UPSTREAM = resolvConf.match(/^nameserver\s+(\d+\.\d+\.\d+\.\d+)\s*$/m)?.[1]
// asks again over TCP when the pod's nameserver says the answer was truncated
const lookUp = UDPClient({ dns: UPSTREAM, timeout: UPSTREAM_TIMEOUT_MS })

// a sandbox asks its controller on 127.0.0.1, where pasta maps port 53, and keeps the pod's search domains
export const SANDBOX_RESOLV_CONF = `${[
  'nameserver 127.0.0.1',
  ...resolvConf.split('\n').filter(line => /^(search|domain|options)\s/.test(line)),
].join('\n')}\n`

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

export const createNetworkController = async (
  { allow = [], deny = [] }: NetworkRules,
  openAddresses: (addresses: string[]) => Promise<void>
) => {
  const opened = new Map<string, Promise<void>>()

  // one nft run per answer with new addresses; an address already added, or being added, starts nothing
  const open = (addresses: string[]) => {
    const fresh = addresses.filter(address => !opened.has(address))
    if (fresh.length) {
      const done = openAddresses(fresh)
      for (const address of fresh) opened.set(address, done)
      done.catch(() => fresh.forEach(address => opened.delete(address)))
    }
    return Promise.all(addresses.map(address => opened.get(address)))
  }

  const reply = (request: Packet, rcode: number) => {
    const response = Packet.createErrorResponseFromRequest(request, rcode)
    response.header.ra = 1
    return response
  }

  const answer = async (request: Packet) => {
    const [question] = request.questions
    if (!question || request.questions.length !== 1) return reply(request, Packet.RCODE.FORMERR)

    const name = question.name.toLowerCase().replace(/\.$/, '')
    if (matchesAny(name, deny) && !matchesAny(name, allow)) {
      log.info({ name }, 'sandbox lookup denied by its deny list')
      return reply(request, Packet.RCODE.NXDOMAIN)
    }
    // dns2 asks only for the types it knows, so a name answers the others with no records
    const type = Packet.TYPE_NAME[question.type]
    if (!type) return reply(request, Packet.RCODE.NOERROR)

    let answered: Packet
    try {
      if (!UPSTREAM) throw new Error('no IPv4 nameserver in /etc/resolv.conf')
      answered = await lookUp(question.name, type, question.class)
    } catch (err) {
      log.info({ name, err }, 'sandbox lookup failed: the pod resolver did not answer')
      return reply(request, Packet.RCODE.SERVFAIL)
    }
    answered.header.id = request.header.id
    // the sandbox has no IPv6, so a name that exists answers AAAA with no addresses
    if (question.type === Packet.TYPE.AAAA) return reply(request, answered.header.rcode)
    if (question.type !== Packet.TYPE.A) return answered

    const addresses = answered.answers.flatMap(record =>
      record.type === Packet.TYPE.A && record.address ? [record.address] : []
    )
    const refused = addresses.find(address => privateAddresses.check(address) && !matchesAny(name, allow))
    if (refused) {
      log.warn(
        { name, address: refused },
        'sandbox lookup refused: the name resolves to an address the sandbox may not reach'
      )
      return reply(request, Packet.RCODE.NXDOMAIN)
    }

    try {
      await open(addresses)
    } catch (err) {
      log.warn({ name, err }, 'sandbox lookup failed: its addresses could not be opened in the sandbox firewall')
      return reply(request, Packet.RCODE.SERVFAIL)
    }
    log.debug({ name, addresses }, 'sandbox lookup allowed')
    return answered
  }

  // a send after close fails, as does one to a client that has gone
  const handle = (request: Packet, send: (response: Packet) => Promise<Buffer>) =>
    void answer(request)
      .then(send)
      .catch(err => log.debug({ err }, 'sandbox lookup not answered'))

  const udp = createUDPServer(handle)
  const tcp = createTCPServer(handle)
  udp.on('error', err => log.warn({ err }, 'sandbox DNS socket failed'))

  udp.bind(0, '127.0.0.1')
  tcp.listen(0, '127.0.0.1')
  await Promise.all([once(udp, 'listening'), once(tcp, 'listening')])

  return {
    udpPort: udp.address().port,
    tcpPort: (tcp.address() as AddressInfo).port,
    close: () => {
      udp.close()
      tcp.close()
    },
  }
}
