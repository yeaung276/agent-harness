import { createMiddleware, type StructuredTool, tool } from 'langchain'
import { z } from 'zod'

import type { Browser } from '../../browser.js'
import { CodeHarnessError } from '../../errors.js'
import { ROOT } from '../../sandbox.js'

const WaitFor = z
  .object({
    selector: z.string().optional().describe('CSS selector of an element to wait for'),
    text: z.string().optional().describe('Text to wait for on the page'),
    timeoutMs: z.number().int().optional().describe('How long to wait, 10000 by default, 60000 at most'),
  })
  .optional()

// a tool's answer; an error goes back to the model as text, so it can recover instead of ending the run
export const attempt = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    const result = await call()
    return typeof result === 'string' ? result : JSON.stringify(result)
  } catch (err) {
    if (err instanceof CodeHarnessError) return `Error: ${err.status ?? err.code} ${err.message}`
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

export const browserTools = (browser: Browser): StructuredTool[] => {
  const tools: StructuredTool[] = [
    tool(({ url, until }) => attempt(() => browser.navigate(url, { until })), {
      name: 'browser_navigate',
      description: browser.sandboxId
        ? 'Open a URL in the browser and return the page as text and numbered refs. A path like "/" opens the launched app.'
        : 'Open a URL in the browser and return the page as text and numbered refs.',
      schema: z.object({
        url: z.string().describe(browser.sandboxId ? 'A path in the app, or a public URL' : 'A public URL'),
        until: WaitFor,
      }),
    }),
    tool(({ maxChars, waitFor }) => attempt(() => browser.read({ maxChars, waitFor })), {
      name: 'browser_read',
      description: 'Read the current page as text and numbered refs.',
      schema: z.object({ maxChars: z.number().int().optional(), waitFor: WaitFor }),
    }),
    tool(({ ref, waitFor }) => attempt(() => browser.click(ref, { waitFor })), {
      name: 'browser_click',
      description: 'Click the element with this ref and return the page after.',
      schema: z.object({ ref: z.number().int().describe('A ref from the last page read'), waitFor: WaitFor }),
    }),
    tool(({ ref, text, submit, waitFor }) => attempt(() => browser.type(ref, text, { submit, waitFor })), {
      name: 'browser_type',
      description: 'Type into the field with this ref and return the page after.',
      schema: z.object({
        ref: z.number().int().describe('A ref from the last page read'),
        text: z.string(),
        submit: z.boolean().optional().describe('Press Enter after typing'),
        waitFor: WaitFor,
      }),
    }),
  ]

  if (browser.record)
    tools.push(
      tool(
        ({ fullPage, waitFor }) =>
          attempt(async () => `${ROOT}/${(await browser.screenshot({ fullPage, waitFor })).path}`),
        {
          name: 'browser_screenshot',
          description: 'Take a PNG screenshot of the page and return its path, which read_file opens.',
          schema: z.object({ fullPage: z.boolean().optional(), waitFor: WaitFor }),
        }
      )
    )

  return tools
}

export function createBrowserUseMiddleware({ browser }: { browser: Browser }) {
  return createMiddleware({
    name: 'BrowserUseMiddleware',
    tools: browserTools(browser),
    afterAgent: async () => {
      await browser.close()
    },
  })
}
