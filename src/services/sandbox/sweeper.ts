const SWEEP_EVERY_MS = 60_000

export const sweeper = (manager: { stopIdle: () => Promise<unknown> }) => {
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
