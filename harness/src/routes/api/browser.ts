import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { eq } from 'drizzle-orm'
import { type Static, Type } from 'typebox'

import { users } from '../../db/schema.ts'
import type { Session } from '../../services/chromium/routes/schema.ts'
import { HttpError } from '../../services/http-error.ts'
import {
  BrowserSession,
  ClickBody,
  CreateBody,
  NavigateBody,
  NavigatedContent,
  PageContent,
  ReadBody,
  RunBody,
  RunResult,
  Screenshot,
  ScreenshotBody,
  SessionParams,
  TypeBody,
} from './schemas/browser.ts'

export const browser: FastifyPluginAsyncTypebox = async app => {
  // calls the worker's internal chromium API; a worker's error answers with its own status
  const forward = async (worker: string, path: string, body: unknown): Promise<unknown> => {
    const res = await app.workers
      .call(worker, `/internal/chromium/${path}`, {
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

  // the worker holding the session's tab, or the one its tab reopens on
  const workerOf = async (sessionId: string) => {
    const session = await app.services.browserSessions.get(sessionId)
    if (!session) throw new HttpError(404, 'No session has this id')

    return app.services.placement.session(sessionId, session.workspaceId)
  }

  app.post('/browser', { schema: { body: CreateBody, response: { 201: BrowserSession } } }, async (request, reply) => {
    const { workspaceId, record } = request.body
    if (record && !workspaceId) throw new HttpError(400, 'record needs a workspaceId')
    if (workspaceId) await app.services.workspaces.get(workspaceId)

    const worker = await app.services.placement.session(null, workspaceId ?? null)
    const session = (await forward(worker, 'session', { ...request.body, userId: request.userId })) as Static<
      typeof Session
    >
    const [createdBy] = await app.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, session.userId))

    return reply.status(201).send({ ...session, createdBy: createdBy! })
  })

  app.post(
    '/browser/:id/navigate',
    { schema: { params: SessionParams, body: NavigateBody, response: { 200: NavigatedContent } } },
    async request => {
      const { id } = request.params

      return (await forward(await workerOf(id), 'navigate', { ...request.body, sessionId: id })) as Static<
        typeof NavigatedContent
      >
    }
  )

  app.post(
    '/browser/:id/read',
    { schema: { params: SessionParams, body: ReadBody, response: { 200: PageContent } } },
    async request => {
      const { id } = request.params

      return (await forward(await workerOf(id), 'read', { ...request.body, sessionId: id })) as Static<
        typeof PageContent
      >
    }
  )

  app.post(
    '/browser/:id/click',
    { schema: { params: SessionParams, body: ClickBody, response: { 200: PageContent } } },
    async request => {
      const { id } = request.params

      return (await forward(await workerOf(id), 'click', { ...request.body, sessionId: id })) as Static<
        typeof PageContent
      >
    }
  )

  app.post(
    '/browser/:id/type',
    { schema: { params: SessionParams, body: TypeBody, response: { 200: PageContent } } },
    async request => {
      const { id } = request.params

      return (await forward(await workerOf(id), 'type', { ...request.body, sessionId: id })) as Static<
        typeof PageContent
      >
    }
  )

  app.post(
    '/browser/:id/screenshot',
    { schema: { params: SessionParams, body: ScreenshotBody, response: { 201: Screenshot } } },
    async (request, reply) => {
      const { id } = request.params
      const shot = await forward(await workerOf(id), 'screenshot', { ...request.body, sessionId: id })

      return reply.status(201).send(shot as Static<typeof Screenshot>)
    }
  )

  app.post(
    '/browser/:id/run',
    { schema: { params: SessionParams, body: RunBody, response: { 200: RunResult } } },
    async request => {
      const { id } = request.params

      return (await forward(await workerOf(id), 'run', { ...request.body, sessionId: id })) as Static<typeof RunResult>
    }
  )

  app.delete(
    '/browser/:id',
    { schema: { params: SessionParams, response: { 204: Type.Null() } } },
    async (request, reply) => {
      const { id } = request.params
      await forward(await workerOf(id), 'close', { sessionId: id })

      return reply.status(204).send(null)
    }
  )
}
