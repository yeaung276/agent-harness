import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chromium as playwright } from 'playwright-core'

import { PROXY_PORT } from '../sandbox/network-controller.ts'
import { createSandbox } from '../sandbox/sandbox.ts'

export const CDP_PORT = 9222

const READY_TIMEOUT_MS = 30_000

export const createChromium = ({ mode, portMin, portMax }: { mode: 'bwrap' | 'none'; portMin: number; portMax: number }) => {
  let sandbox: ReturnType<typeof createSandbox> | undefined
  let endpoint: string | undefined
  let stopping = false
  let cleanup: Promise<unknown> = Promise.resolve()
  const exitHandlers: ((output: string) => void)[] = []

  const connectionUrl = () => {
    if (!endpoint) throw new Error('chromium is not running')

    return endpoint
  }

  return {
    connectionUrl,

    connect: () => playwright.connectOverCDP(connectionUrl()),

    start: async () => {
      stopping = false

      const dir = await mkdtemp(join(tmpdir(), 'chromium-'))
      const args = [
        playwright.executablePath(),
        '--headless',
        `--remote-debugging-port=${CDP_PORT}`,
        '--remote-debugging-address=127.0.0.1',
        '--user-data-dir=profile',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        '--use-mock-keychain',
        '--password-store=basic',
        '--no-sandbox',
        ...(mode === 'bwrap' ? [`--proxy-server=http://127.0.0.1:${PROXY_PORT}`] : []),
        'about:blank',
      ]

      const launched = createSandbox('chromium', {
        dir,
        mode,
        memoryMaxMb: 2048,
        cpuMax: 2,
        pidsMax: 1024,
        command: `exec ${args.map(arg => `'${arg}'`).join(' ')}`,
        env: {},
        ports: { inside: CDP_PORT, host: CDP_PORT },
        outboundPorts: `${portMin}-${portMax}`,
        readyTimeoutMs: READY_TIMEOUT_MS,
      })
      sandbox = launched

      cleanup = launched.exited().then(async () => {
        const current = sandbox === launched
        if (current) {
          sandbox = undefined
          endpoint = undefined
        }

        const output = (await launched.logs(50)).join('\n')
        await launched.deleteLogs()
        await rm(dir, { recursive: true, force: true })

        if (current && !stopping) for (const handler of exitHandlers) handler(output)
      })

      try {
        await launched.ready()

        const deadline = Date.now() + READY_TIMEOUT_MS
        for (;;) {
          const output = (await launched.logs(200)).join('\n')
          endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1]
          if (endpoint) break
          if (launched.status() !== 'running' || Date.now() > deadline) throw new Error(`no CDP endpoint\n${output}`)

          await Bun.sleep(100)
        }
      } catch (error) {
        sandbox = undefined
        endpoint = undefined
        await launched.kill()
        await cleanup
        throw new Error(`chromium did not start: ${error instanceof Error ? error.message : error}`)
      }
    },

    stop: async () => {
      stopping = true

      const launched = sandbox
      sandbox = undefined
      endpoint = undefined

      await launched?.kill()
      await cleanup
    },

    logs: async (tail: number) => (await sandbox?.logs(tail, true)) ?? [],

    onExit: (handler: (output: string) => void) => {
      exitHandlers.push(handler)
    },
  }
}

export type Chromium = ReturnType<typeof createChromium>
