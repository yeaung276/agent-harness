import type { FastifyBaseLogger } from 'fastify'

const noop = () => {}
const silent = {
  level: 'silent',
  fatal: noop,
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  trace: noop,
  silent: noop,
  child: () => silent,
} as unknown as FastifyBaseLogger

let current = silent

// buildApp binds app.log here; until then, and in tests that never build the app, lines go nowhere
export const bindLogger = (logger: FastifyBaseLogger) => {
  current = logger
}

// a module's logger, every line tagged with its component; it takes its child of the bound logger on use, so a module can create it at import, before buildApp runs
export const logger = (component: string) => {
  let parent: FastifyBaseLogger | undefined
  let child = silent

  return new Proxy(silent, {
    get: (_, key) => {
      if (parent !== current) {
        parent = current
        child = current.child({ component })
      }

      const value = Reflect.get(child, key, child)
      return typeof value === 'function' ? value.bind(child) : value
    },
  })
}
