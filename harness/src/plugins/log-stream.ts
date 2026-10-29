import fp from 'fastify-plugin'
import { pino } from 'pino'

const FLUSH_MS = 1000
const FLUSH_LINES = 200
const BUFFER_LINES = 1000

export const logStream = fp(
  async app => {
    const { WORKER_NAME, LOG_MAX_LINES, LOG_TTL_HOURS, LOG_LEVEL } = app.config
    const key = `logs:${WORKER_NAME}`
    let buffer: string[] = []
    let dropped = 0
    let flushing = false

    const keepNewest = () => {
      const over = buffer.length - BUFFER_LINES
      if (over <= 0) return
      dropped += over
      buffer.splice(0, over)
    }

    const droppedNotice = () =>
      JSON.stringify({
        level: 40,
        time: Date.now(),
        component: 'log-stream',
        msg: `${dropped} log lines were dropped while Redis was unreachable`,
      })

    const flush = async () => {
      if (flushing || buffer.length === 0 || app.redis.status !== 'ready') return
      flushing = true
      const lines = dropped > 0 ? [droppedNotice(), ...buffer] : buffer
      const sent = buffer
      buffer = []

      try {
        const pipeline = app.redis.pipeline()
        for (const line of lines) pipeline.xadd(key, 'MAXLEN', '~', LOG_MAX_LINES, '*', 'line', line)
        pipeline.expire(key, Math.round(LOG_TTL_HOURS * 60 * 60))
        const results = await pipeline.exec()
        if (!results || results.some(([err]) => err)) throw new Error('log flush failed')
        dropped = 0
      } catch {
        buffer = [...sent, ...buffer]
        keepNewest()
      } finally {
        flushing = false
      }
    }

    const redisLogs = {
      write: (line: string) => {
        buffer.push(line.trimEnd())
        keepNewest()
        if (buffer.length >= FLUSH_LINES) void flush()
      },
    }

    const log = app.log as unknown as Record<symbol, pino.DestinationStream>
    log[pino.symbols.streamSym] = pino.multistream([
      { level: LOG_LEVEL, stream: log[pino.symbols.streamSym]! },
      { level: LOG_LEVEL, stream: redisLogs },
    ])

    if (app.redis.status === 'wait') app.redis.connect().catch(() => {})
    const timer = setInterval(() => void flush(), FLUSH_MS)
    app.addHook('onClose', async () => {
      clearInterval(timer)
      await flush()
    })
  },
  { name: 'log-stream', dependencies: ['redis'] }
)
