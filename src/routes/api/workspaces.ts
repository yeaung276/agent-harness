import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'

import { readForm } from '../../plugins/multipart.ts'
import { HttpError } from '../../services/http-error.ts'
import { CreateWorkspaceBody, UploadAccepted, Workspace, WorkspaceParams } from './schemas/workspaces.ts'

export const workspaces: FastifyPluginAsyncTypebox = async app => {
  app.post(
    '/workspaces',
    { schema: { body: CreateWorkspaceBody, response: { 201: Workspace } } },
    async (request, reply) =>
      reply.status(201).send(await app.services.workspaces.create(request.userId, request.body.name))
  )

  app.get(
    '/workspaces/:id',
    { schema: { params: WorkspaceParams, response: { 200: Workspace } } },
    async request => app.services.workspaces.get(request.params.id)
  )

  app.delete(
    '/workspaces/:id',
    { schema: { params: WorkspaceParams, response: { 204: Type.Null() } } },
    async (request, reply) => {
      await app.services.workspaces.delete(request.params.id)

      return reply.status(204).send(null)
    }
  )

  app.post(
    '/workspaces/:id/upload',
    { schema: { params: WorkspaceParams, response: { 202: UploadAccepted } } },
    async (request, reply) => {
      const { fields, file } = await readForm(request, app.services.workspaces.uploadsDir)
      if (!file) throw new HttpError(400, 'Send the zip in a field named file')

      const accepted = await app.services.workspaces.extract(request.params.id, { zip: file, path: fields.path ?? '' })

      return reply.status(202).send(accepted)
    }
  )
}
