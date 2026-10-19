import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'

// mock rows until workspaces exist
const WORKSPACES = [
  { name: 'billing-api', status: 'Running', owner: 'alice@example.com', updated: '2m ago' },
  { name: 'docs-site', status: 'Stopped', owner: 'bob@example.com', updated: '1h ago' },
  { name: 'landing-page', status: 'Running', owner: 'alice@example.com', updated: '3d ago' },
  { name: 'support-bot', status: 'Stopped', owner: 'carol@example.com', updated: '2w ago' },
]

export const workspaces: FastifyPluginAsyncTypebox = async app => {
  app.get('/workspaces', async (_request, reply) =>
    reply.viewAsync('workspaces', { title: 'Workspaces', active: 'workspaces', workspaces: WORKSPACES })
  )
}
