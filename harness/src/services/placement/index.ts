import type { Redis } from 'ioredis'

import { logger } from '../../logger.ts'
import { HttpError } from '../http-error.ts'

const log = logger('placement')

// deletes the key only while it still holds the given value
const DELETE_IF_HOLDS = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0"
// a workspace's process stops sandboxIdleMs after its last call ends, at the next sweep, so its claim, renewed
// when a call starts, holds that much longer: a 4 min exec, a 1 min sweep, and stalls seen at 9 min
const CLAIM_MARGIN_MS = 15 * 60 * 1000

export type Need = 'new' | 'running' | 'any'

const workspaceKey = (workspaceId: string) => `placement:workspace:${workspaceId}`
const sessionKey = (sessionId: string) => `placement:session:${sessionId}`

const freeSlots = (pod: Record<string, string>) => Number(pod.sandboxSlots) - Number(pod.sandboxes)
// a worker whose sandboxes have no memory limit has no bound here
const freeMemory = (pod: Record<string, string>) =>
  pod.sandboxMemoryFreeBytes === undefined ? Infinity : Number(pod.sandboxMemoryFreeBytes)

export const createPlacementService = ({
  redis,
  workerName,
  sandboxIdleMs,
  browserIdleMs,
  minFreeMemoryMb,
}: {
  redis: Redis
  workerName: string | undefined
  sandboxIdleMs: number
  browserIdleMs: number
  minFreeMemoryMb: number
}) => {
  const minFreeMemory = minFreeMemoryMb * 1024 * 1024
  const claimMs = sandboxIdleMs + CLAIM_MARGIN_MS
  const bootId = crypto.randomUUID()
  const owner = `${workerName}:${bootId}`

  // the worker a key names, while that boot of it still reports; reading renews the key
  const liveOwner = async (key: string, ttlMs: number) => {
    const value = await redis.getex(key, 'PX', ttlMs)
    if (!value) return null

    const [name, boot] = value.split(':')
    const [reportedAt, reportedBootId] = await redis.hmget(`pods:${name}`, 'reportedAt', 'bootId')
    if (reportedAt && reportedBootId === boot) return name!

    await redis.eval(DELETE_IF_HOLDS, 1, key, value)
    log.info({ key, value }, 'placement of a gone worker removed')
    return null
  }

  const mostFree = async () => {
    const keys: string[] = []
    let cursor = '0'
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', 'pods:*', 'COUNT', 100)
      cursor = next
      keys.push(...batch)
    } while (cursor !== '0')

    const eligible = (await Promise.all(keys.map(key => redis.hgetall(key)))).filter(
      pod => pod.reportedAt && pod.bootId && freeSlots(pod) > 0 && freeMemory(pod) >= minFreeMemory
    )
    eligible.sort(
      (a, b) => freeSlots(b) - freeSlots(a) || freeMemory(b) - freeMemory(a) || Number(a.sessions) - Number(b.sessions)
    )
    const pod = eligible[0]
    if (!pod) throw new HttpError(503, 'No worker is available')

    // counted until the worker's next report, so a burst of picks spreads instead of landing on the same worker
    const key = `pods:${pod.hostname}`
    const reserve = redis.multi().hincrby(key, 'sandboxes', 1)
    if (pod.sandboxMemoryFreeBytes !== undefined) reserve.hincrby(key, 'sandboxMemoryFreeBytes', -minFreeMemory)
    await reserve.exec()

    return pod.hostname!
  }

  const workspace = async (workspaceId: string, need: Need) => {
    const name = await liveOwner(workspaceKey(workspaceId), claimMs)
    if (name && need === 'new') throw new HttpError(409, 'A background process is already running')
    if (name) return name
    if (need === 'running') throw new HttpError(409, 'Nothing is running in this workspace')

    return mostFree()
  }

  return {
    bootId,

    // the server: which worker to call
    workspace,

    session: async (sessionId: string | null, workspaceId: string | null) => {
      const name = sessionId ? await liveOwner(sessionKey(sessionId), browserIdleMs) : null
      if (name) return name

      return workspaceId ? workspace(workspaceId, 'any') : mostFree()
    },

    // the worker: what it holds; true when it took a free claim, false when it renewed its own
    claimWorkspace: async (workspaceId: string) => {
      const key = workspaceKey(workspaceId)
      if (await redis.set(key, owner, 'PX', claimMs, 'NX')) return true
      if ((await redis.getex(key, 'PX', claimMs)) !== owner)
        throw new HttpError(409, 'This workspace is running on another worker')
      return false
    },

    releaseWorkspace: async (workspaceId: string) => {
      await redis.eval(DELETE_IF_HOLDS, 1, workspaceKey(workspaceId), owner)
    },

    claimSession: async (sessionId: string) => {
      await redis.set(sessionKey(sessionId), owner, 'PX', browserIdleMs)
    },

    releaseSession: async (sessionId: string) => {
      await redis.eval(DELETE_IF_HOLDS, 1, sessionKey(sessionId), owner)
    },
  }
}
