import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'

import { HttpError } from '../../services/http-error.ts'
import { isBinary } from '../../services/workspaces/files.ts'
import { EditFileBody, FileContent, FileParams, ReadFileQuery, Tree, TreeQuery, WriteFileBody } from './schemas/files.ts'
import { WorkspaceParams } from './schemas/workspaces.ts'

export const files: FastifyPluginAsyncTypebox = async app => {
  app.get(
    '/workspaces/:id/tree',
    { schema: { params: WorkspaceParams, querystring: TreeQuery, response: { 200: Tree } } },
    async request => ({
      paths: await app.services.workspaces.tree(request.params.id, request.query.path, {
        secrets: true,
        recursive: true,
      }),
    })
  )

  app.get(
    '/workspaces/:id/files/*',
    { schema: { params: FileParams, querystring: ReadFileQuery, response: { 200: FileContent } } },
    async request => {
      const path = request.params['*']
      const { offset, limit } = request.query
      const bytes = await app.services.workspaces.readFile(request.params.id, path)
      if (isBinary(bytes)) throw new HttpError(400, `${path} is binary`)
      if (limit === undefined && bytes.length > 512 * 1024)
        throw new HttpError(400, `${path} is over 512 KB; read it in parts with offset and limit`)

      const lines = bytes.toString().split('\n')
      if (lines.at(-1) === '') lines.pop()

      return {
        content: lines
          .slice(offset, offset + (limit ?? lines.length))
          .map(line => (line.length > 2000 ? `${line.slice(0, 2000)}… [truncated]` : line))
          .join('\n'),
        totalLines: lines.length,
      }
    }
  )

  app.put(
    '/workspaces/:id/files/*',
    { schema: { params: FileParams, body: WriteFileBody, response: { 204: Type.Null() } } },
    async (request, reply) => {
      await app.services.workspaces.writeFile(request.params.id, request.params['*'], request.body.content)

      return reply.status(204).send(null)
    }
  )

  app.patch(
    '/workspaces/:id/files/*',
    { schema: { params: FileParams, body: EditFileBody, response: { 204: Type.Null() } } },
    async (request, reply) => {
      const { search, replace } = request.body
      await app.services.workspaces.editFile(request.params.id, request.params['*'], search, replace)

      return reply.status(204).send(null)
    }
  )

  app.delete(
    '/workspaces/:id/files/*',
    { schema: { params: FileParams, response: { 204: Type.Null() } } },
    async (request, reply) => {
      await app.services.workspaces.deleteFile(request.params.id, request.params['*'])

      return reply.status(204).send(null)
    }
  )
}
