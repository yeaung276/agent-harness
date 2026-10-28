import fp from 'fastify-plugin'

import { createCa } from '../services/workers/certs.ts'

declare module 'fastify' {
  interface FastifyInstance {
    workers: {
      ca: Awaited<ReturnType<typeof createCa>>
      caCert: string
      serverCert: { key: string; cert: string }
    }
  }
}

export const workers = fp(
  async app => {
    const { WORKER_CA_KEY, WORKER_CA_CERT } = app.config
    if (!WORKER_CA_KEY || !WORKER_CA_CERT) throw new Error('the server needs WORKER_CA_KEY and WORKER_CA_CERT for its workers')

    const ca = await createCa({ key: WORKER_CA_KEY, cert: WORKER_CA_CERT })
    app.decorate('workers', { ca, caCert: WORKER_CA_CERT, serverCert: await ca.issueServerCert() })
  },
  { name: 'workers' }
)
