import { createMiddleware, type StructuredTool, tool } from 'langchain'
import { z } from 'zod'

import { ROOT, type Sandbox } from '../../sandbox.js'
import { attempt, browserTools } from './browser-use.js'

const PROMPT = `## Code-Harness sandbox

Your files are in ${ROOT}, and execute runs commands from there. Install dependencies in the same command that needs them; a later command may not have them.
Start the app with launch_app, then open it with the browser tools at a path like "/" or "/login". When it fails, read app_logs.`

export function createCodeHarnessMiddleware({ sandbox }: { sandbox: Sandbox }) {
  const { browser } = sandbox

  const tools: StructuredTool[] = [
    tool(
      ({ command, port, env }) =>
        attempt(async () => {
          await sandbox.stop()
          return (await sandbox.launch({ command, port, env })).url
        }),
      {
        name: 'launch_app',
        description:
          'Start the app in the background, stopping the one running, and return its public URL once it listens on port. Put the install step in the command, like "npm ci && npm start".',
        schema: z.object({
          command: z.string().describe('Shell command that starts the app'),
          port: z.number().int().describe('Port the app listens on; PORT is set to it'),
          env: z.record(z.string(), z.string()).optional().describe('Env for the app'),
        }),
      }
    ),
    tool(({ tail }) => attempt(async () => (await sandbox.logs({ tail })).join('\n')), {
      name: 'app_logs',
      description: 'The last lines the app wrote. After it ends, the last line says how.',
      schema: z.object({ tail: z.number().int().optional().describe('How many lines, 200 by default, 1000 at most') }),
    }),
    ...browserTools(browser),
  ]

  return createMiddleware({
    name: 'CodeHarnessMiddleware',
    tools,
    wrapModelCall: (request, handler) => handler({ ...request, systemMessage: request.systemMessage.concat(PROMPT) }),
    afterAgent: async () => {
      await browser.close()
    },
  })
}
