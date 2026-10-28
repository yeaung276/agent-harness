import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Browser } from 'playwright-core'

import { logger } from '../../logger.ts'
import type { createBrowserSessionService } from '../browser-sessions/index.ts'
import { HttpError } from '../http-error.ts'
import type { createSandboxManager } from '../sandbox/manager.ts'
import type { createWorkspaceService } from '../workspaces/index.ts'
import { createChromium } from './chromium.ts'
import { type NavigatedContent, ops, type PageContent, type WaitFor } from './ops.ts'
import { createRunner } from './runner.ts'
import { createSession, type Session } from './session.ts'

const log = logger('chromium-manager')

const CALL_TIMEOUT_MS = 60 * 1000
const RESTART_DELAY_MS = 1000

type BrowserSession = NonNullable<Awaited<ReturnType<ReturnType<typeof createBrowserSessionService>['get']>>>

export const createChromiumManager = ({
  workspaces,
  sandboxes,
  browserSessions,
  mode,
  portMin,
  portMax,
  idleMs,
}: {
  workspaces: ReturnType<typeof createWorkspaceService>
  sandboxes: ReturnType<typeof createSandboxManager>
  browserSessions: ReturnType<typeof createBrowserSessionService>
  mode: 'bwrap' | 'none'
  portMin: number
  portMax: number
  idleMs: number
}) => {
  const chromium = createChromium({ mode, portMin, portMax })
  const runner = createRunner({ mode, chromium })
  const tabs = new Map<string, Session>()
  const locks = new Map<string, Promise<unknown>>()
  let connection: Browser | undefined
  let stopping = false

  const locked = async <T>(sessionId: string, fn: () => Promise<T>) => {
    const previous = locks.get(sessionId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(fn)
    locks.set(sessionId, current)

    try {
      return await current
    } finally {
      if (locks.get(sessionId) === current) locks.delete(sessionId)
    }
  }

  const restart = async () => {
    while (!stopping) {
      await Bun.sleep(RESTART_DELAY_MS)
      if (stopping) return

      try {
        await chromium.start()
        connection = await chromium.connect()
        log.info('chromium restarted')
        return
      } catch (err) {
        log.warn({ err }, 'chromium restart failed, retrying')
      }
    }
  }

  const openTab = async ({ id, workspaceId, record, url, storageState }: BrowserSession) => {
    if (!connection?.isConnected()) throw new HttpError(503, 'The browser is restarting. Try again shortly.')

    const tab = await createSession(connection, {
      record,
      getWorkspaceAccessPort: workspaceId ? () => sandboxes.hostPort(workspaceId) : undefined,
      url,
      storageState,
    })
    tabs.set(id, tab)

    return tab
  }

  const closeTab = async ({ id, workspaceId, record }: BrowserSession) => {
    const tab = tabs.get(id)
    tabs.delete(id)
    // keep where the tab is, so it reopens there
    const state = tab?.isOpen() ? await tab.state().catch(() => ({})) : {}
    await tab?.close()

    if (record) {
      await tab?.exportRecording(join(workspaces.getWorkspaceRoot(workspaceId!), 'browser', `${id}-${Date.now()}.webm`))
    }
    await browserSessions.update(id, { ...state, status: 'closed' })
  }

  const exec = (sessionId: string, code: string, timeoutMs: number) =>
    locked(sessionId, async () => {
      const browserSession = await browserSessions.get(sessionId)
      if (!browserSession) throw new HttpError(404, 'No session has this id')

      // a closed, idle or lost tab opens again where the row left off
      let tab = tabs.get(sessionId)
      if (!tab?.isOpen()) {
        if (tab) await closeTab(browserSession)
        tab = await openTab(browserSession)
        await browserSessions.update(sessionId, { status: 'alive' })
        log.info({ sessionId }, 'browser session tab reopened where it left off')
      }

      const release = tab.use()
      try {
        const ran = await runner.exec(tab.targetId, code, timeoutMs)
        log.info({ sessionId, durationMs: ran.durationMs, timedOut: ran.timedOut, error: ran.error }, 'browser call finished')
        await browserSessions.update(sessionId, await tab.state())

        return ran
      } finally {
        release()
      }
    })

  return {
    start: async () => {
      chromium.onExit(() => {
        log.error({ lostTabs: tabs.size }, 'chromium exited unexpectedly, restarting')
        tabs.clear()
        connection = undefined
        void restart()
      })

      await chromium.start()
      connection = await chromium.connect()
    },

    create: async (userId: string, { workspaceId, record }: { workspaceId: string | null; record: boolean }) => {
      if (record && !workspaceId) throw new HttpError(400, 'record needs a workspaceId')
      if (workspaceId) await workspaces.get(workspaceId)
      if (!connection?.isConnected()) throw new HttpError(503, 'The browser is restarting. Try again shortly.')

      const browserSession = await browserSessions.create(userId, { workspaceId, record })
      await openTab(browserSession)
      log.info({ sessionId: browserSession.id, workspaceId, record, userId }, 'browser session created')

      return browserSession
    },

    navigate: async (sessionId: string, url: string, until?: WaitFor) => {
      const workspaceId = (await browserSessions.get(sessionId))?.workspaceId
      const workspaceAccessPort = workspaceId ? sandboxes.hostPort(workspaceId) : null
      const ran = await exec(
        sessionId,
        ops.navigate(url, workspaceAccessPort, until),
        CALL_TIMEOUT_MS + (until?.timeoutMs ?? 0)
      )

      if (ran.timedOut) throw new HttpError(504, "The page didn't load in time")
      if (ran.error !== null) throw new HttpError(400, ran.error)

      return ran.result as NavigatedContent
    },

    read: async (sessionId: string, maxChars?: number, waitFor?: WaitFor) => {
      const ran = await exec(sessionId, ops.read(maxChars, waitFor), CALL_TIMEOUT_MS + (waitFor?.timeoutMs ?? 0))

      if (ran.timedOut) throw new HttpError(504, "The call didn't finish in time")
      if (ran.error === 'wait_for_timed_out') throw new HttpError(504, "What waitFor names didn't show up in time")
      if (ran.error !== null) throw new HttpError(400, ran.error)

      return ran.result as PageContent
    },

    click: async (sessionId: string, ref: number, waitFor?: WaitFor) => {
      const ran = await exec(sessionId, ops.click(ref, waitFor), CALL_TIMEOUT_MS + (waitFor?.timeoutMs ?? 0))

      if (ran.timedOut) throw new HttpError(504, "The call didn't finish in time")
      if (ran.error === 'wait_for_timed_out') throw new HttpError(504, "What waitFor names didn't show up in time")
      if (ran.error === 'ref_not_found') throw new HttpError(404, 'No element on the page has this ref')
      if (ran.error !== null) throw new HttpError(400, ran.error)

      return ran.result as PageContent
    },

    type: async (sessionId: string, ref: number, text: string, submit: boolean, waitFor?: WaitFor) => {
      const ran = await exec(
        sessionId,
        ops.type(ref, text, submit, waitFor),
        CALL_TIMEOUT_MS + (waitFor?.timeoutMs ?? 0)
      )

      if (ran.timedOut) throw new HttpError(504, "The call didn't finish in time")
      if (ran.error === 'wait_for_timed_out') throw new HttpError(504, "What waitFor names didn't show up in time")
      if (ran.error === 'ref_not_found') throw new HttpError(404, 'No element on the page has this ref')
      if (ran.error !== null) throw new HttpError(400, ran.error)

      return ran.result as PageContent
    },

    screenshot: async (sessionId: string, fullPage: boolean, waitFor?: WaitFor) => {
      const browserSession = await browserSessions.get(sessionId)
      if (!browserSession) throw new HttpError(404, 'No session has this id')
      if (!browserSession.record) throw new HttpError(409, "The session wasn't created with record")

      const ran = await exec(sessionId, ops.screenshot(fullPage, waitFor), CALL_TIMEOUT_MS + (waitFor?.timeoutMs ?? 0))

      if (ran.timedOut) throw new HttpError(504, "The call didn't finish in time")
      if (ran.error === 'wait_for_timed_out') throw new HttpError(504, "What waitFor names didn't show up in time")
      if (ran.error !== null) throw new HttpError(400, ran.error)

      const root = workspaces.getWorkspaceRoot(browserSession.workspaceId!)
      const path = join('screenshot', `${sessionId}-${Date.now()}.png`)
      await mkdir(join(root, 'screenshot'), { recursive: true })
      await writeFile(join(root, path), Buffer.from((ran.result as { png: string }).png, 'base64'))

      return { path }
    },

    run: async (sessionId: string, code: string, timeoutMs: number) => {
      const { result, error, durationMs } = await exec(sessionId, ops.arbitrary(code), timeoutMs)

      return { result, error, durationMs }
    },

    // refresh stuck page with new tab, to bypass stuck tabs
    // refresh: async (sessionId: string) => {},

    close: (sessionId: string) =>
      locked(sessionId, async () => {
        const browserSession = await browserSessions.get(sessionId)
        if (browserSession?.status !== 'alive') {
          throw new HttpError(404, 'No session has this id, or it is already closed')
        }

        await closeTab(browserSession)
        log.info({ sessionId }, 'browser session closed')
      }),

    count: () => tabs.size,

    stopIdle: async () => {
      await Promise.all(
        [...tabs]
          .filter(([, tab]) => tab.isIdle(idleMs))
          .map(([sessionId]) =>
            locked(sessionId, async () => {
              const browserSession = await browserSessions.get(sessionId)
              if (browserSession) await closeTab(browserSession)
              log.info({ sessionId }, 'idle browser session tab closed')
            })
          )
      )
    },

    stopAll: async () => {
      stopping = true
      await Promise.all(
        [...tabs.keys()].map(sessionId =>
          locked(sessionId, async () => {
            const browserSession = await browserSessions.get(sessionId)
            if (browserSession) await closeTab(browserSession)
          })
        )
      )
      connection = undefined
      await chromium.stop()
    },
  }
}
