import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'

import { readForm } from '../../plugins/multipart.ts'
import { HttpError } from '../../services/http-error.ts'
import { WorkspaceParams, WorkspacesQuery } from './schemas/workspaces.ts'

const PAGE_SIZE = 20

const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium' })

export const workspaces: FastifyPluginAsyncTypebox = async app => {
  const view = async (page: number, form: { name: string; error: string } | null = null) => {
    const offset = (page - 1) * PAGE_SIZE
    const { items, total } = await app.services.workspaces.list({ limit: PAGE_SIZE, offset })

    return {
      title: 'Workspaces',
      active: 'workspaces',
      form,
      workspaces: items.map(item => ({
        id: item.id,
        name: item.name,
        status: item.status,
        created: date.format(item.createdAt),
        createdBy: item.createdBy.email,
      })),
      pagination: {
        from: offset + 1,
        to: offset + items.length,
        total,
        prev: page > 1 ? page - 1 : null,
        next: offset + items.length < total ? page + 1 : null,
      },
    }
  }

  app.get('/workspaces', { schema: { querystring: WorkspacesQuery } }, async (request, reply) =>
    reply.viewAsync('workspaces', await view(request.query.page))
  )

  app.post('/workspaces', async (request, reply) => {
    const { fields, file } = await readForm(request, app.services.workspaces.uploadsDir)
    const name = fields.name ?? ''

    try {
      const workspace = await app.services.workspaces.create(request.userId, name)
      if (file) await app.services.workspaces.extract(workspace.id, { zip: file, path: '' })
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
      return reply.status(err.status).viewAsync('workspaces', await view(1, { name, error: err.message }))
    }

    return reply.redirect('/workspaces')
  })

  app.post('/workspaces/:id/delete', { schema: { params: WorkspaceParams } }, async (request, reply) => {
    await app.services.workspaces.delete(request.params.id).catch(err => {
      if (!(err instanceof HttpError) || err.status !== 404) throw err
    })

    return reply.redirect('/workspaces')
  })
}
