import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'

import { requireToken } from './auth.ts'
import { me } from './me.ts'
import { workspaces } from './workspaces.ts'

export const api: FastifyPluginAsyncTypebox = async app => {
  await app.register(requireToken)

  await app.register(me)
  await app.register(workspaces)
}
