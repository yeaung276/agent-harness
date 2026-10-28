import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import fp from 'fastify-plugin'

import { logger } from '../../logger.ts'

const log = logger('stats-reporter')

const CGROUP_ROOT = '/sys/fs/cgroup'
const REPORT_MS = 10_000
const STATS_TTL_S = 30

const readCgroup = (file: string) =>
  readFile(join(CGROUP_ROOT, file), 'utf8').then(
    text => text.trim(),
    () => null
  )

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
        const [cpuStat, memory, memoryMax] = await Promise.all([
          readCgroup('cpu.stat'),
          readCgroup('memory.current'),
          readCgroup('memory.max'),
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
          reportedAt: now,
          cpuPercent,
          memoryBytes: memory,
          memoryLimitBytes: memoryMax === 'max' ? null : memoryMax,
          sandboxes: app.sandbox.count(),
          sandboxSlots: app.config.SANDBOX_PORT_MAX - app.config.SANDBOX_PORT_MIN + 1,
          sessions: app.chromium.count(),
        }
      }

      const report = async () => {
        const stats = Object.fromEntries(Object.entries(await collect()).filter(([, value]) => value !== null))
        await app.redis.multi().hset(statsKey, stats).expire(statsKey, STATS_TTL_S).exec()
      }

      const tick = () => void report().catch(err => log.error({ err }, 'stats report failed'))

      app.addHook('onListen', async () => {
        tick()
        timer = setInterval(tick, REPORT_MS)
      })
      app.addHook('onClose', async () => clearInterval(timer))
    },
    { name: 'stats-reporter', dependencies: ['redis', 'sandbox', 'chromium'] }
  )
