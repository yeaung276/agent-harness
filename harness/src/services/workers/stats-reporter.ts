import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import fp from 'fastify-plugin'

import { logger } from '../../logger.ts'
import { SANDBOXES_CGROUP } from '../sandbox/sandbox.ts'

const log = logger('stats-reporter')

const CGROUP_ROOT = '/sys/fs/cgroup'
const REPORT_MS = 10_000
const STATS_TTL_S = 30

const readCgroup = (file: string) =>
  readFile(join(CGROUP_ROOT, file), 'utf8').then(
    text => text.trim(),
    () => null
  )

// kubelet's working set: memory.current less the inactive page cache, which the kernel reclaims first
const workingSet = async (cgroup: string) => {
  const [current, stat] = await Promise.all([
    readCgroup(join(cgroup, 'memory.current')),
    readCgroup(join(cgroup, 'memory.stat')),
  ])
  if (current === null) return null

  return Math.max(0, Number(current) - Number(stat?.match(/^inactive_file (\d+)$/m)?.[1] ?? 0))
}

// a counter from memory.events or memory.events.local, which count since the cgroup was made
const eventCount = (events: string | null, name: string) => {
  const count = events?.match(new RegExp(`^${name} (\\d+)$`, 'm'))?.[1]
  return count === undefined ? null : Number(count)
}

export const createStatsReporter = ({
  statsKey,
  hostname,
  address,
}: {
  statsKey: string
  hostname: string
  address: string
}) =>
  fp(
    async app => {
      let lastCpu: { usageUsec: number; at: number } | null = null
      let timer: ReturnType<typeof setInterval> | undefined
      let execs = 0

      const collect = async () => {
        const [
          cpuStat,
          memory,
          memoryMax,
          sandboxesMemory,
          sandboxesMemoryMax,
          sandboxesStat,
          sandboxesEvents,
          sandboxesLocalEvents,
        ] = await Promise.all([
          readCgroup('cpu.stat'),
          workingSet(''),
          readCgroup('memory.max'),
          workingSet(SANDBOXES_CGROUP),
          readCgroup(join(SANDBOXES_CGROUP, 'memory.max')),
          readCgroup(join(SANDBOXES_CGROUP, 'memory.stat')),
          readCgroup(join(SANDBOXES_CGROUP, 'memory.events')),
          readCgroup(join(SANDBOXES_CGROUP, 'memory.events.local')),
        ])
        // the file name and metadata cache that finished commands leave behind, which the kernel frees when the sandboxes need the memory
        const sandboxesReclaimable = Number(sandboxesStat?.match(/^slab_reclaimable (\d+)$/m)?.[1] ?? 0)
        const usageUsec = Number(cpuStat?.match(/^usage_usec (\d+)$/m)?.[1] ?? Number.NaN)
        const now = Date.now()
        const cpuPercent = lastCpu
          ? Math.round(((usageUsec - lastCpu.usageUsec) / 1000 / (now - lastCpu.at)) * 100)
          : null
        lastCpu = Number.isNaN(usageUsec) ? null : { usageUsec, at: now }

        return {
          hostname,
          address,
          bootId: app.services.placement.bootId,
          reportedAt: now,
          cpuPercent,
          memoryBytes: memory,
          memoryLimitBytes: memoryMax === 'max' ? null : memoryMax,
          sandboxMemoryFreeBytes:
            sandboxesMemoryMax === null || sandboxesMemoryMax === 'max' || sandboxesMemory === null
              ? null
              : Math.max(0, Number(sandboxesMemoryMax) - Math.max(0, sandboxesMemory - sandboxesReclaimable)),
          sandboxMemoryLimitHits: eventCount(sandboxesLocalEvents, 'max'),
          sandboxOomKills: eventCount(sandboxesEvents, 'oom_kill'),
          sandboxes: app.sandbox.count(),
          execs,
          sandboxSlots: app.config.SANDBOX_PORT_MAX - app.config.SANDBOX_PORT_MIN + 1,
          sessions: app.chromium.count(),
        }
      }

      const report = async () => {
        const stats = Object.fromEntries(Object.entries(await collect()).filter(([, value]) => value !== null))
        await app.redis.multi().hset(statsKey, stats).expire(statsKey, STATS_TTL_S).exec()
      }

      // one report at a time; a tick during one sends one more after it
      let running = false
      let again = false
      const tick = () => {
        if (running) {
          again = true
          return
        }
        running = true
        void report()
          .catch(err => log.error({ err }, 'stats report failed'))
          .finally(() => {
            running = false
            if (again) {
              again = false
              tick()
            }
          })
      }

      app.sandbox.onChange(event => {
        if (event === 'exec-start') execs++
        if (event === 'exec-end') execs--
        tick()
      })
      app.chromium.onChange(tick)

      app.addHook('onListen', async () => {
        tick()
        timer = setInterval(tick, REPORT_MS)
      })
      app.addHook('onClose', async () => {
        clearInterval(timer)
        await app.redis.del(statsKey)
      })
    },
    { name: 'stats-reporter', dependencies: ['redis', 'services', 'sandbox', 'chromium'] }
  )
