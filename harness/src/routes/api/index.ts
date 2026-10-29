import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'

import { requireToken } from './auth.ts'
import { browser } from './browser.ts'
import { files } from './files.ts'
import { me } from './me.ts'
import { sandbox } from './sandbox.ts'
import { workspaces } from './workspaces.ts'

export const api: FastifyPluginAsyncTypebox = async app => {
  await app.register(requireToken)

  await app.register(me)
  await app.register(workspaces)
  await app.register(files)
  await app.register(sandbox)
  await app.register(browser)
}
