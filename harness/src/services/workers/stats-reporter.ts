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

      const collect = async () => {
        const [cpuStat, memory, memoryMax, sandboxesMemory, sandboxesMemoryMax] = await Promise.all([
          readCgroup('cpu.stat'),
          workingSet(''),
          readCgroup('memory.max'),
          workingSet(SANDBOXES_CGROUP),
          readCgroup(join(SANDBOXES_CGROUP, 'memory.max')),
        ])
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
              : Math.max(0, Number(sandboxesMemoryMax) - sandboxesMemory),
          sandboxes: app.sandbox.count(),
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

      app.sandbox.onChange(tick)
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
