import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createSandbox } from '../sandbox/sandbox.ts'
import { CDP_PORT, type Chromium } from './chromium.ts'

const MAX_RESULT_BYTES = 32 * 1024 * 1024
const PLAYWRIGHT_CORE = dirname(require.resolve('playwright-core'))

const RUN_SCRIPT = String.raw`
const util = require('node:util')
const { connectionUrl, playwrightCore, targetId, code } = input

const out = process.stdout.write.bind(process.stdout)
process.stdout.write = process.stderr.write.bind(process.stderr)
for (const level of ['log', 'info', 'debug', 'dir', 'table']) {
  console[level] = (...args) => process.stderr.write(util.format(...args) + '\n')
}

const reply = value => {
  let line
  try {
    line = JSON.stringify(value)
  } catch (err) {
    line = JSON.stringify({ result: null, error: 'the result is not JSON: ' + err.message })
  }
  out(line + '\n', () => process.exit(0))
}

const main = async () => {
  const { chromium } = require(playwrightCore)
  const browser = await chromium.connectOverCDP(connectionUrl)

  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const cdp = await context.newCDPSession(page)
      const { targetInfo } = await cdp.send('Target.getTargetInfo')
      await cdp.detach()
      if (targetInfo.targetId !== targetId) continue

      const AsyncFunction = (async () => {}).constructor
      try {
        const result = await new AsyncFunction('page', code)(page)
        return reply({ result: result === undefined ? null : result, error: null })
      } catch (err) {
        return reply({ result: null, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  reply({ result: null, error: 'page_not_found' })
}

main().catch(err => reply({ result: null, error: err instanceof Error ? err.message : String(err) }))
`

export type RunResult = {
  result: unknown
  error: string | null
  timedOut: boolean
  durationMs: number
}

export const createRunner = ({ mode, chromium }: { mode: 'bwrap' | 'none'; chromium: Chromium }) => ({
  exec: async (targetId: string, code: string, timeoutMs: number): Promise<RunResult> => {
    const dir = await mkdtemp(join(tmpdir(), 'chromium-run-'))

    const input = {
      connectionUrl: chromium.connectionUrl(),
      playwrightCore: mode === 'bwrap' ? join('/workspace', 'node_modules/playwright-core') : PLAYWRIGHT_CORE,
      targetId,
      code,
    }
    const script = `const input = ${JSON.stringify(input)}\n${RUN_SCRIPT}`

    const startedAt = Date.now()
    const sandbox = createSandbox(`run-${crypto.randomUUID()}`, {
      dir,
      mounts: [{ source: PLAYWRIGHT_CORE, target: 'node_modules/playwright-core', readOnly: true }],
      mode,
      memoryMaxMb: 512,
      cpuMax: 1,
      pidsMax: 128,
      command: `exec '${process.execPath}' -e '${script.replaceAll("'", `'\\''`)}'`,
      env: {},
      network: { deny: ['*'] },
      outboundPorts: String(CDP_PORT),
      stdout: 'pipe',
    })

    let output = ''
    let timedOut = false
    sandbox.stdout?.on('data', chunk => {
      output += chunk
      if (output.length > MAX_RESULT_BYTES) void sandbox.kill()
    })
    const timer = setTimeout(() => {
      timedOut = true
      void sandbox.kill()
    }, timeoutMs)
    const exitCode = await sandbox.exited()
    clearTimeout(timer)
    await rm(dir, { recursive: true, force: true })

    const durationMs = Date.now() - startedAt
    if (timedOut) return { result: null, error: `timed out after ${timeoutMs / 1000} s`, timedOut, durationMs }
    if (output.length > MAX_RESULT_BYTES) return { result: null, error: 'the result is over 32 MB', timedOut, durationMs }

    try {
      const { result, error } = JSON.parse(output)
      return { result, error, timedOut, durationMs }
    } catch {
      return { result: null, error: `the runner exited with ${exitCode}`, timedOut, durationMs }
    }
  },
})

export type Runner = ReturnType<typeof createRunner>
