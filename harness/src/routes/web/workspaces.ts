import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Value } from 'typebox/value'

import { readForm } from '../../plugins/multipart.ts'
import { HttpError } from '../../services/http-error.ts'
import {
  ActivitiesQuery,
  DefaultEnv,
  DefaultEnvChanges,
  EnvForm,
  FileParams,
  LogsQuery,
  TreeQuery,
  WorkspaceParams,
  WorkspacesQuery,
} from './schemas/workspaces.ts'

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
        defaultEnvKeys: item.defaultEnvKeys,
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

  app.get('/workspaces/:id', { schema: { params: WorkspaceParams } }, async (request, reply) => {
    const workspace = await app.services.workspaces.get(request.params.id)

    return reply.viewAsync('workspace', { title: workspace.name, active: 'workspaces', workspace })
  })

  app.post('/workspaces', async (request, reply) => {
    const { fields, file } = await readForm(request, app.services.workspaces.uploadsDir)
    const name = fields.name ?? ''
    const defaultEnv = JSON.parse(fields.defaultEnv || '{}')

    try {
      if (!Value.Check(DefaultEnv, defaultEnv)) throw new HttpError(400, 'Environment variable values must be text')
      const workspace = await app.services.workspaces.create(request.userId, name, defaultEnv)
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

  app.post('/workspaces/:id/env', { schema: { params: WorkspaceParams, body: EnvForm } }, async (request, reply) => {
    const defaultEnv = JSON.parse(request.body.defaultEnv)
    if (!Value.Check(DefaultEnvChanges, defaultEnv))
      throw new HttpError(400, 'Environment variable values must be text or null')
    await app.services.workspaces.update(request.params.id, { defaultEnv })

    return reply.redirect('/workspaces')
  })

  app.get('/workspaces/:id/tree', { schema: { params: WorkspaceParams, querystring: TreeQuery } }, async request => {
    const { id } = request.params
    const paths = await app.services.workspaces.tree(id, request.query.path, { secrets: false, recursive: false })
    const entries = await Promise.all(paths.map(path => app.services.workspaces.describeFile(id, path)))

    return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
  })

  app.get(
    '/workspaces/:id/activities',
    { schema: { params: WorkspaceParams, querystring: ActivitiesQuery } },
    async request => {
      const { id } = request.params
      await app.services.workspaces.get(id)
      const offset = (request.query.page - 1) * PAGE_SIZE
      const { items, total } = await app.services.activities.list(id, { limit: PAGE_SIZE, offset })

      return {
        items,
        pagination: {
          from: offset + 1,
          to: offset + items.length,
          total,
          prev: request.query.page > 1 ? request.query.page - 1 : null,
          next: offset + items.length < total ? request.query.page + 1 : null,
        },
      }
    }
  )

  app.get('/workspaces/:id/logs', { schema: { params: WorkspaceParams, querystring: LogsQuery } }, async request => {
    await app.services.workspaces.get(request.params.id)

    return { lines: [] as string[] }
  })

  app.get('/workspaces/:id/files/*', { schema: { params: FileParams } }, async (request, reply) => {
    const path = request.params['*']
    const bytes = await app.services.workspaces.readFile(request.params.id, path)

    return reply
      .header('content-security-policy', 'sandbox')
      .header('x-content-type-options', 'nosniff')
      .type(Bun.file(path).type)
      .send(bytes)
  })
}
