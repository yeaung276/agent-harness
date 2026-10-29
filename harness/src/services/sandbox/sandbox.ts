import { spawn } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { mkdir, readFile, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Config } from '../../config.ts'
import type { Mount } from './deps-cache.ts'
import { createLog } from './log.ts'
import { createNetworkController, type NetworkRules, PROXY_ENV, PROXY_PORT } from './network-controller.ts'

const CGROUP_ROOT = '/sys/fs/cgroup'
const CGROUP_CONTROLLERS = ['memory', 'cpu', 'pids']

export type SandboxOptions = {
  dir: string
  mounts?: Mount[]
  mode: 'bwrap' | 'none'
  memoryMaxMb: number
  cpuMax: number
  pidsMax: number
  command: string
  env: Record<string, string>
  network?: NetworkRules
  ports?: { inside: number; host: number }
  outboundPorts?: string
  readyTimeoutMs?: number
  joinPid?: number
  // 'log' (default) writes stdout and stderr to a log file read by logs(); 'pipe' hands stdout back as the sandbox's stdout stream and drops stderr: nothing is written to a log file, and logs() returns nothing
  stdout?: 'log' | 'pipe'
}

export type SandboxStatus = 'starting' | 'running' | 'failed' | 'stopped'

export const createSandbox = (
  workspaceId: string,
  {
    dir,
    mounts = [],
    mode,
    memoryMaxMb,
    cpuMax,
    pidsMax,
    command,
    env,
    network,
    ports,
    outboundPorts,
    readyTimeoutMs,
    joinPid,
    stdout = 'log',
  }: SandboxOptions
) => {
  let inUse = 0
  let lastUsedAt = Date.now()
  let status: SandboxStatus = ports ? 'starting' : 'running'

  const log = stdout === 'log' ? createLog() : null
  const cgroup = join(CGROUP_ROOT, `workspace-${workspaceId}`)
  const controller = mode === 'bwrap' && joinPid === undefined ? createNetworkController(network ?? {}) : null

  const namespace =
    joinPid === undefined
      ? [
          'pasta',
          '--config-net',
          '--quiet',
          '-4',
          '-t',
          ports ? `127.0.0.1/${ports.host}:${ports.inside}` : 'none',
          '-u',
          'none',
          '-T',
          `${PROXY_PORT}:${controller?.port}`,
          ...(outboundPorts ? ['-T', outboundPorts] : []),
          '-U',
          'none',
          '--no-map-gw',
          '--host-lo-to-ns-lo',
          '--',
          'unshare',
          '--mount',
          '--propagation',
          'private',
          'bash',
          '-c',
          'set -e; mount -t proc proc /proc; printf "%s" "$1" | nft -f -; shift; ' +
            'for fd in /proc/$$/fd/*; do fd=${fd##*/}; if [ "$fd" -gt 2 ]; then exec {fd}>&-; fi; done; exec "$@"',
          'bash',
          'table inet sandbox { chain output { type filter hook output priority 0; policy drop; oifname "lo" accept; }; }',
        ]
      : [
          'sh',
          '-c',
          'target=$1; shift; for try in $(seq 50); do ' +
            'ns=$(cat /proc/$target/task/$target/children 2>/dev/null); ns=${ns%% *}; ' +
            'net=$(readlink /proc/$ns/ns/net 2>/dev/null); comm=$(cat /proc/$ns/comm 2>/dev/null); ' +
            'if [ "$comm" = bwrap ] && [ -n "$net" ] && [ "$net" != "$(readlink /proc/self/ns/net)" ]; then ' +
            'exec nsenter --target "$ns" --user --net --preserve-credentials -- "$@"; fi; sleep 0.1; done; ' +
            'echo "the launched process has no network to join" >&2; exit 1',
          'sh',
          String(joinPid),
        ]

  const bwrap = [
    'bwrap',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--setenv',
    'HOME',
    '/tmp',
    '--bind',
    dir,
    '/workspace',
    ...mounts.flatMap(({ source, target, readOnly }) => [
      readOnly ? '--ro-bind' : '--bind',
      source,
      join('/workspace', target),
    ]),
    '--chdir',
    '/workspace',
    ...[
      '/usr',
      '/bin',
      '/sbin',
      '/lib',
      '/lib64',
      '/opt',
      '/etc/alternatives',
      '/etc/resolv.conf',
      '/etc/ssl',
      '/etc/ca-certificates',
      '/etc/hosts',
      '/etc/fonts',
    ].flatMap(path => ['--ro-bind-try', path, path]),
    '--tmpfs',
    process.cwd(),
    '--',
    'sh',
    '-c',
    command,
  ]

  const args =
    mode === 'none'
      ? ['-c', command]
      : [
          '-c',
          'set -e; cg=$1; mkdir -p "$cg"; echo "$2" > "$cg/memory.max"; echo "$3" > "$cg/cpu.max"; ' +
            'echo "$4" > "$cg/pids.max"; [ ! -f "$cg/memory.swap.max" ] || echo 0 > "$cg/memory.swap.max"; ' +
            'echo $$ > "$cg/cgroup.procs"; shift 4; exec "$@"',
          'sh',
          cgroup,
          String(memoryMaxMb * 1024 * 1024),
          `${Math.round(cpuMax * 100_000)} 100000`,
          String(pidsMax),
          ...namespace,
          ...bwrap,
        ]

  const child = spawn('sh', args, {
    cwd: dir,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => ['PATH', 'LANG', 'LC_ALL', 'TZ'].includes(key))
      ),
      HOME: tmpdir(),
      ...(mode === 'bwrap' ? PROXY_ENV : {}),
      ...env,
      ...(mode === 'none' && ports ? { PORT: String(ports.host) } : {}),
    },
    detached: true,
    stdio: log ? ['ignore', log.fd, log.fd] : ['ignore', 'pipe', 'ignore'],
  })
  child.on('error', error => log?.write(`${error.message}\n`))

  const killTree = async () => {
    if (child.pid === undefined) return

    const group = -child.pid
    try {
      process.kill(group, 'SIGTERM')
    } catch {}
    const timer = setTimeout(() => {
      try {
        process.kill(group, 'SIGKILL')
      } catch {}
    }, 5000)
    await finished
    clearTimeout(timer)
  }

  const readiness = new Promise<void>(resolve => {
    if (!ports) return resolve()

    const deadline = Date.now() + (readyTimeoutMs ?? Infinity)
    const check = async () => {
      const answered = await fetch(`http://127.0.0.1:${ports.host}/`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(2000),
      }).then(
        () => true,
        () => false
      )
      if (answered && status === 'starting') status = 'running'
      if (status === 'starting' && Date.now() >= deadline) {
        status = 'failed'
        await killTree()
      }

      if (status === 'starting') setTimeout(check, 300)
      else resolve()
    }
    void check()
  })

  const finished = new Promise<number | null>(resolve =>
    child.once('close', exitCode => {
      controller?.close()
      if (status !== 'stopped') status = ports ? 'failed' : 'stopped'
      if (mode === 'bwrap') {
        void (async () => {
          for (let attempt = 0; attempt < 20; attempt++) {
            if (
              await rmdir(cgroup).then(
                () => true,
                error => error.code === 'ENOENT'
              )
            )
              return
            await Bun.sleep(100)
          }
        })()
      }
      resolve(exitCode)
    })
  )

  return {
    pid: child.pid ?? 0,

    port: (mode === 'none' ? ports?.host : ports?.inside) ?? null,

    hostPort: ports?.host ?? null,

    status: () => status,

    ready: async () => {
      await readiness
      if (status !== 'running') throw new Error(((await log?.tail(20, true)) ?? []).join('\n'))
    },

    exited: () => finished,

    stdout: child.stdout,

    logs: async (tail: number, clean?: boolean) => (await log?.tail(tail, clean)) ?? [],

    deleteLogs: async () => {
      await log?.remove()
    },

    kill: async () => {
      if (status === 'failed' || status === 'stopped') return
      status = 'stopped'
      await killTree()
    },

    use: () => {
      inUse++
      lastUsedAt = Date.now()

      let released = false
      return () => {
        if (released) return
        released = true
        inUse--
        lastUsedAt = Date.now()
      }
    },

    isIdle: (idleMs: number) => inUse === 0 && Date.now() - lastUsedAt > idleMs,
  }
}

export const assertSandboxUsable = (config: Config) => {
  if (config.SANDBOX_MODE === 'none') {
    if (config.NODE_ENV !== 'production') return

    throw new Error(
      'SANDBOX_MODE=none is not allowed with NODE_ENV=production. ' +
        'Workspace code would run unconfined. Set SANDBOX_MODE=bwrap.'
    )
  }

  if (process.platform !== 'linux') throw new Error(`SANDBOX_MODE=bwrap needs Linux (got '${process.platform}').`)

  const missing = ['bwrap', 'pasta', 'nft', 'unshare', 'nsenter', 'bash'].filter(tool => !Bun.which(tool))
  if (missing.length > 0) throw new Error(`SANDBOX_MODE=bwrap needs ${missing.join(', ')} on PATH.`)

  let controllers: string[] = []
  try {
    controllers = readFileSync(join(CGROUP_ROOT, 'cgroup.controllers'), 'utf8').split(/\s+/)
  } catch {}
  const absent = CGROUP_CONTROLLERS.filter(controller => !controllers.includes(controller))
  if (absent.length > 0)
    throw new Error(`SANDBOX_MODE=bwrap needs cgroup v2 with ${absent.join(', ')} at ${CGROUP_ROOT}.`)

  for (const file of ['cgroup.procs', 'cgroup.subtree_control']) {
    try {
      accessSync(join(CGROUP_ROOT, file), constants.W_OK)
    } catch {
      throw new Error(`SANDBOX_MODE=bwrap needs ${CGROUP_ROOT} delegated to this user.`)
    }
  }

  const [low = 0, high = 0] = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8')
    .trim()
    .split(/\s+/)
    .map(Number)
  if (low <= config.SANDBOX_PORT_MAX && config.SANDBOX_PORT_MIN <= high) {
    throw new Error(
      `SANDBOX_MODE=bwrap needs SANDBOX_PORT_MIN..SANDBOX_PORT_MAX (${config.SANDBOX_PORT_MIN}-${config.SANDBOX_PORT_MAX}) ` +
        `outside net.ipv4.ip_local_port_range (${low}-${high}).`
    )
  }
}

export const setupCgroups = async (mode: 'bwrap' | 'none') => {
  if (mode === 'none') return

  await mkdir(join(CGROUP_ROOT, 'runner'), { recursive: true })

  for (let pass = 0; ; pass++) {
    const pids = (await readFile(join(CGROUP_ROOT, 'cgroup.procs'), 'utf8')).split('\n').filter(Boolean)
    if (pids.length === 0) break
    if (pass === 10) throw new Error(`could not move processes ${pids.join(', ')} out of ${CGROUP_ROOT}`)

    for (const pid of pids) {
      await writeFile(join(CGROUP_ROOT, 'runner', 'cgroup.procs'), pid).catch(() => {})
    }
  }

  await writeFile(
    join(CGROUP_ROOT, 'cgroup.subtree_control'),
    CGROUP_CONTROLLERS.map(controller => `+${controller}`).join(' ')
  )
}
