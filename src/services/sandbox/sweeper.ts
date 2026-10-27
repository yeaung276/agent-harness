import type { createSandboxManager } from './manager.ts'

const SWEEP_EVERY_MS = 60_000

export const sweeper = (manager: ReturnType<typeof createSandboxManager>) => {
  let timer: NodeJS.Timeout | undefined

  return {
    start: () => {
      timer = setInterval(() => void manager.stopIdle().catch(() => undefined), SWEEP_EVERY_MS)
      timer.unref()
    },

    stop: () => {
      clearInterval(timer)
      timer = undefined
    },
  }
}
