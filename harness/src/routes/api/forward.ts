import type { FastifyInstance } from 'fastify'

import { HttpError } from '../../services/http-error.ts'

// calls a worker's internal API; a worker's error answers with its own status
export const forward = async (app: FastifyInstance, worker: string, path: string, body: unknown): Promise<unknown> => {
  const res = await app.workers
    .call(worker, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    .catch(err => {
      if (err instanceof HttpError) throw err
      app.log.warn({ worker, path, err }, 'worker unreachable')
      throw new HttpError(503, `worker ${worker} can't be reached`)
    })
  if (!res.ok) {
    const { message } = (await res.json().catch(() => ({}))) as { message?: string }
    throw new HttpError(res.status, message ?? `worker ${worker} answered ${res.status}`)
  }

  return res.status === 204 ? null : res.json()
}
