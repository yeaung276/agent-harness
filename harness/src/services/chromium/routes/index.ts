import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'

import {
  ClickBody,
  CloseBody,
  CreateBody,
  NavigateBody,
  NavigatedContent,
  PageContent,
  ReadBody,
  RunBody,
  RunResult,
  Screenshot,
  ScreenshotBody,
  Session,
  TypeBody,
} from './schema.ts'

export const chromiumRoutes: FastifyPluginAsyncTypebox = async app => {
  app.post('/session', { schema: { body: CreateBody, response: { 201: Session } } }, async (request, reply) => {
    const { userId, workspaceId, record } = request.body
    const session = await app.chromium.create(userId, { workspaceId: workspaceId ?? null, record })

    return reply.status(201).send(session)
  })

  app.post('/navigate', { schema: { body: NavigateBody, response: { 200: NavigatedContent } } }, async request => {
    const { sessionId, url, until } = request.body

    return app.chromium.navigate(sessionId, url, until)
  })

  app.post('/read', { schema: { body: ReadBody, response: { 200: PageContent } } }, async request => {
    const { sessionId, maxChars, waitFor } = request.body

    return app.chromium.read(sessionId, maxChars, waitFor)
  })

  app.post('/click', { schema: { body: ClickBody, response: { 200: PageContent } } }, async request => {
    const { sessionId, ref, waitFor } = request.body

    return app.chromium.click(sessionId, ref, waitFor)
  })

  app.post('/type', { schema: { body: TypeBody, response: { 200: PageContent } } }, async request => {
    const { sessionId, ref, text, submit, waitFor } = request.body

    return app.chromium.type(sessionId, ref, text, submit, waitFor)
  })

  app.post('/screenshot', { schema: { body: ScreenshotBody, response: { 201: Screenshot } } }, async (request, reply) => {
    const { sessionId, fullPage, waitFor } = request.body

    return reply.status(201).send(await app.chromium.screenshot(sessionId, fullPage, waitFor))
  })

  app.post('/run', { schema: { body: RunBody, response: { 200: RunResult } } }, async request => {
    const { sessionId, code, timeoutMs } = request.body

    return app.chromium.run(sessionId, code, timeoutMs)
  })

  app.post('/close', { schema: { body: CloseBody, response: { 204: Type.Null() } } }, async (request, reply) => {
    await app.chromium.close(request.body.sessionId)

    return reply.status(204).send(null)
  })
}
