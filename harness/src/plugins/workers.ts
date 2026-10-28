import fp from 'fastify-plugin'

import { createWorkerService } from '../services/workers/index.ts'

declare module 'fastify' {
  interface FastifyInstance {
    workers: Awaited<ReturnType<typeof createWorkerService>>
  }
}

export const workers = fp(
  async app => {
    const { WORKER_CA_KEY, WORKER_CA_CERT } = app.config
    if (!WORKER_CA_KEY || !WORKER_CA_CERT) throw new Error('the server needs WORKER_CA_KEY and WORKER_CA_CERT for its workers')

    app.decorate(
      'workers',
      await createWorkerService({ db: app.db, redis: app.redis, caKey: WORKER_CA_KEY, caCert: WORKER_CA_CERT })
    )
  },
  { name: 'workers', dependencies: ['db', 'redis'] }
)
