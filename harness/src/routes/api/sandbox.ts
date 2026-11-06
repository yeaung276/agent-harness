import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { type Static, Type } from 'typebox'

import { HttpError } from '../../services/http-error.ts'
import type { Need } from '../../services/placement/index.ts'
import { readRedisLog } from '../../services/sandbox/log.ts'
import { launchLogKey } from '../../services/sandbox/manager.ts'
import { forward } from './forward.ts'
import { ExecBody, ExecResult, LaunchBody, Launched, Logs, LogsQuery } from './schemas/sandbox.ts'
import { WorkspaceParams } from './schemas/workspaces.ts'

export const sandbox: FastifyPluginAsyncTypebox = async app => {
  // the worker running the workspace, or the one to run it on, as the call needs
  const workerOf = async (workspaceId: string, need: Need) => {
    await app.services.workspaces.get(workspaceId)

    return app.services.placement.workspace(workspaceId, need)
  }

  app.post(
    '/workspaces/:id/sandbox/launch',
    { schema: { params: WorkspaceParams, body: LaunchBody, response: { 201: Launched } } },
    async (request, reply) => {
      const { id } = request.params
      await forward(app, await workerOf(id, 'new'), '/internal/sandbox/launch', { ...request.body, workspaceId: id })

      return reply.status(201).send({ url: app.proxy.urlOf(id) })
    }
  )

  app.post(
    '/workspaces/:id/sandbox/exec',
    { schema: { params: WorkspaceParams, body: ExecBody, response: { 200: ExecResult } } },
    async request => {
      const { id } = request.params

      return (await forward(app, await workerOf(id, 'any'), '/internal/sandbox/exec', {
        ...request.body,
        workspaceId: id,
      })) as Static<typeof ExecResult>
    }
  )

  app.post(
    '/workspaces/:id/sandbox/stop',
    { schema: { params: WorkspaceParams, response: { 204: Type.Null() } } },
    async (request, reply) => {
      const { id } = request.params
      const worker = await workerOf(id, 'running').catch(err => {
        if (err instanceof HttpError && err.status === 409) return null
        throw err
      })

      if (worker) await forward(app, worker, '/internal/sandbox/stop', { workspaceId: id })
      else await app.services.workspaces.setStatus(id, 'stopped')

      return reply.status(204).send(null)
    }
  )

  app.get(
    '/workspaces/:id/sandbox/logs',
    { schema: { params: WorkspaceParams, querystring: LogsQuery, response: { 200: Logs } } },
    async request => {
      const { id } = request.params
      await app.services.workspaces.get(id)

      return { lines: await readRedisLog(app.redis, launchLogKey(id), request.query.tail) }
    }
  )

  app.get(
    '/workspaces/:id/sandbox/url',
    { schema: { params: WorkspaceParams, response: { 200: Launched } } },
    async request => {
      const { id } = request.params
      await app.services.workspaces.get(id)
      if (!(await app.services.workspaces.getLaunchOptions(id)))
        throw new HttpError(409, 'No launch has started in this workspace yet')

      return { url: app.proxy.urlOf(id) }
    }
  )
}
