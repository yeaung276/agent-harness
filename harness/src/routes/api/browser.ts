import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { type Static, Type } from 'typebox'

import { HttpError } from '../../services/http-error.ts'
import { forward } from './forward.ts'
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

const MAX_WORKSPACE_SESSIONS = 5

export const browser: FastifyPluginAsyncTypebox = async app => {
  // the worker holding the session's tab, or the one its tab reopens on
  const workerOf = async (sessionId: string) => {
    const session = await app.services.browsers.get(sessionId)
    if (!session) throw new HttpError(404, 'No session has this id')

    return app.services.placement.session(sessionId, session.workspaceId)
  }

  app.post('/browser', { schema: { body: CreateBody, response: { 201: BrowserSession } } }, async (request, reply) => {
    const { workspaceId, record } = request.body
    if (record && !workspaceId) throw new HttpError(400, 'record needs a workspaceId')
    if (workspaceId) await app.services.workspaces.get(workspaceId)
    if (
      workspaceId &&
      (await app.services.browsers.countOpen(workspaceId, app.config.BROWSER_IDLE_MS)) >= MAX_WORKSPACE_SESSIONS
    )
      throw new HttpError(429, 'Too many sessions are open for this workspace')

    const worker = await app.services.placement.session(null, workspaceId ?? null)
    const session = await forward(app, worker, '/internal/chromium/session', {
      ...request.body,
      userId: request.userId,
    })

    return reply.status(201).send(session as Static<typeof BrowserSession>)
  })

  app.post(
    '/browser/:id/navigate',
    { schema: { params: SessionParams, body: NavigateBody, response: { 200: NavigatedContent } } },
    async request => {
      const { id } = request.params

      return (await forward(app, await workerOf(id), '/internal/chromium/navigate', {
        ...request.body,
        sessionId: id,
      })) as Static<typeof NavigatedContent>
    }
  )

  app.post(
    '/browser/:id/read',
    { schema: { params: SessionParams, body: ReadBody, response: { 200: PageContent } } },
    async request => {
      const { id } = request.params

      return (await forward(app, await workerOf(id), '/internal/chromium/read', {
        ...request.body,
        sessionId: id,
      })) as Static<typeof PageContent>
    }
  )

  app.post(
    '/browser/:id/click',
    { schema: { params: SessionParams, body: ClickBody, response: { 200: PageContent } } },
    async request => {
      const { id } = request.params

      return (await forward(app, await workerOf(id), '/internal/chromium/click', {
        ...request.body,
        sessionId: id,
      })) as Static<typeof PageContent>
    }
  )

  app.post(
    '/browser/:id/type',
    { schema: { params: SessionParams, body: TypeBody, response: { 200: PageContent } } },
    async request => {
      const { id } = request.params

      return (await forward(app, await workerOf(id), '/internal/chromium/type', {
        ...request.body,
        sessionId: id,
      })) as Static<typeof PageContent>
    }
  )

  app.post(
    '/browser/:id/screenshot',
    { schema: { params: SessionParams, body: ScreenshotBody, response: { 201: Screenshot } } },
    async (request, reply) => {
      const { id } = request.params
      const shot = await forward(app, await workerOf(id), '/internal/chromium/screenshot', {
        ...request.body,
        sessionId: id,
      })

      return reply.status(201).send(shot as Static<typeof Screenshot>)
    }
  )

  app.post(
    '/browser/:id/run',
    { schema: { params: SessionParams, body: RunBody, response: { 200: RunResult } } },
    async request => {
      const { id } = request.params

      return (await forward(app, await workerOf(id), '/internal/chromium/run', {
        ...request.body,
        sessionId: id,
      })) as Static<typeof RunResult>
    }
  )

  app.delete(
    '/browser/:id',
    { schema: { params: SessionParams, response: { 204: Type.Null() } } },
    async (request, reply) => {
      const { id } = request.params
      await forward(app, await workerOf(id), '/internal/chromium/close', { sessionId: id })

      return reply.status(204).send(null)
    }
  )
}
