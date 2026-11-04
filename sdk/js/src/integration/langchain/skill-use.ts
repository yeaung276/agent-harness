import { createSkillsMiddleware } from 'deepagents'

import type { Sandbox } from '../../sandbox.js'

export function createSkillUseMiddleware({
  sandbox,
  sources,
}: {
  sandbox: Sandbox
  sources: string[]
}): ReturnType<typeof createSkillsMiddleware> {
  return createSkillsMiddleware({ backend: sandbox, sources })
}
