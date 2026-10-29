import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { chromium as playwright } from 'playwright-core'

import { logger } from '../../logger.ts'
import { PROXY_PORT } from '../sandbox/network-controller.ts'
import { createSandbox } from '../sandbox/sandbox.ts'

const log = logger('chromium')

export const CDP_PORT = 9222

const READY_TIMEOUT_MS = 30_000

export const createChromium = ({
  mode,
  portMin,
  portMax,
}: {
  mode: 'bwrap' | 'none'
  portMin: number
  portMax: number
}) => {
  let sandbox: ReturnType<typeof createSandbox> | undefined
  let stopping = false
  let cleanup: Promise<unknown> = Promise.resolve()
  const exitHandlers: (() => void)[] = []

  const connectionUrl = () => {
    if (!sandbox) throw new Error('chromium is not running')

    return `http://127.0.0.1:${CDP_PORT}`
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
        command: `exec ${args.map(arg => `'${arg}'`).join(' ')} 2>&1`,
        env: {},
        ports: { inside: CDP_PORT, host: CDP_PORT },
        outboundPorts: `${portMin}-${portMax}`,
        readyTimeoutMs: READY_TIMEOUT_MS,
        stdout: 'pipe',
      })
      sandbox = launched
      if (launched.stdout) {
        // the pipe is read even when nothing logs, so chromium never blocks on a full pipe
        createInterface({ input: launched.stdout }).on('line', line => log.info({ output: line }, 'chromium printed'))
      }

      cleanup = launched.exited().then(async () => {
        const current = sandbox === launched
        if (current) sandbox = undefined

        await rm(dir, { recursive: true, force: true })

        if (current && !stopping) for (const handler of exitHandlers) handler()
      })

      try {
        await launched.ready()
        await (await fetch(`${connectionUrl()}/json/version`)).json()
        log.info('chromium started')
      } catch (error) {
        sandbox = undefined
        await launched.kill()
        await cleanup
        throw new Error(`chromium did not start: ${error instanceof Error ? error.message : error}`)
      }
    },

    stop: async () => {
      stopping = true

      const launched = sandbox
      sandbox = undefined

      await launched?.kill()
      await cleanup
    },

    onExit: (handler: () => void) => {
      exitHandlers.push(handler)
    },
  }
}

export type Chromium = ReturnType<typeof createChromium>
