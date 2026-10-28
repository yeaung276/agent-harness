import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'

import { readForm } from '../../plugins/multipart.ts'
import { HttpError } from '../../services/http-error.ts'
import {
  CreateWorkspaceBody,
  UpdateWorkspaceBody,
  UploadAccepted,
  Workspace,
  WorkspaceParams,
} from './schemas/workspaces.ts'

export const workspaces: FastifyPluginAsyncTypebox = async app => {
  app.post(
    '/workspaces',
    { schema: { body: CreateWorkspaceBody, response: { 201: Workspace } } },
    async (request, reply) =>
      reply
        .status(201)
        .send(await app.services.workspaces.create(request.userId, request.body.name, request.body.defaultEnv))
  )

  app.get(
    '/workspaces/:id',
    { schema: { params: WorkspaceParams, response: { 200: Workspace } } },
    async request => app.services.workspaces.get(request.params.id)
  )

  app.patch(
    '/workspaces/:id',
    { schema: { params: WorkspaceParams, body: UpdateWorkspaceBody, response: { 204: Type.Null() } } },
    async (request, reply) => {
      await app.services.workspaces.update(request.params.id, request.body)

      return reply.status(204).send(null)
    }
  )

  app.delete(
    '/workspaces/:id',
    { schema: { params: WorkspaceParams, response: { 204: Type.Null() } } },
    async (request, reply) => {
      await app.services.workspaces.delete(request.params.id)

      return reply.status(204).send(null)
    }
  )

  app.put(
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
