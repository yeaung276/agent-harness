import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'

import { ExecBody, ExecResult, LaunchBody, StopBody } from './schema.ts'

export const sandboxRoutes: FastifyPluginAsyncTypebox = async app => {
  app.post('/launch', { schema: { body: LaunchBody, response: { 204: Type.Null() } } }, async (request, reply) => {
    const { workspaceId, command, port, env = {}, network = {} } = request.body
    await app.sandbox.launch(workspaceId, { command, port, env, network })

    return reply.status(204).send(null)
  })

  app.post('/exec', { schema: { body: ExecBody, response: { 200: ExecResult } } }, async request => {
    const { workspaceId, command, timeoutMs, env = {} } = request.body

    return app.sandbox.exec(workspaceId, { command, timeoutMs, env })
  })

  app.post('/stop', { schema: { body: StopBody, response: { 204: Type.Null() } } }, async (request, reply) => {
    await app.sandbox.stop(request.body.workspaceId)

    return reply.status(204).send(null)
  })
}
