import fp from 'fastify-plugin'
import { Redis } from 'ioredis'

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis
  }
}

export const redis = fp(
  async app => {
    const redis = new Redis(app.config.REDIS_URL, { lazyConnect: true })
    redis.on('error', err => app.log.error(err, 'redis error'))
    redis.on('ready', () => app.log.info('redis connected'))

    app.decorate('redis', redis)
    app.addHook('onClose', async () => {
      // quit() waits for Redis to reply, which never happens while it is unreachable
      if (redis.status === 'ready') await redis.quit()
      else redis.disconnect()
    })
  },
  { name: 'redis' }
)
