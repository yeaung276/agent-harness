import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Browser, BrowserContextOptions, Video } from 'playwright-core'

import { guard } from './guard.ts'

const VIEWPORT = { width: 1280, height: 800 }
const RECORDINGS_DIR = join(tmpdir(), 'chromium-recordings')

export type SessionState = {
  url: string | null
  storageState: Exclude<NonNullable<BrowserContextOptions['storageState']>, string> | null
}

export const createSession = async (
  browser: Browser,
  {
    record,
    getWorkspaceAccessPort,
    url,
    storageState,
  }: SessionState & { record: boolean; getWorkspaceAccessPort?: () => number | null }
) => {
  if (record) await mkdir(RECORDINGS_DIR, { recursive: true })

  const context = await browser.newContext({
    storageState: storageState ?? undefined,
    serviceWorkers: 'block',
    viewport: VIEWPORT,
    recordVideo: record ? { dir: RECORDINGS_DIR, size: VIEWPORT } : undefined,
  })
  await guard(context, getWorkspaceAccessPort)

  const page = await context.newPage()
  let video: Video | null = page.video()
  const cdp = await context.newCDPSession(page)
  const { targetId } = (await cdp.send('Target.getTargetInfo')).targetInfo
  await cdp.detach()

  if (url) await page.goto(url).catch(() => undefined)

  let inUse = 0
  let lastUsedAt = Date.now()

  return {
    targetId,

    isOpen: () => !page.isClosed(),

    state: async (): Promise<SessionState> => {
      const pageUrl = page.url()

      return { url: pageUrl === 'about:blank' ? null : pageUrl, storageState: await context.storageState() }
    },

    use: () => {
      inUse++
      lastUsedAt = Date.now()

      let released = false
      return () => {
        if (released) return
        released = true
        inUse--
        lastUsedAt = Date.now()
      }
    },

    isIdle: (idleMs: number) => inUse === 0 && Date.now() - lastUsedAt > idleMs,

    close: async () => {
      await context.close().catch(() => undefined)
    },

    exportRecording: async (path: string) => {
      if (!video) return

      await mkdir(dirname(path), { recursive: true })
      await video.saveAs(path)
      await video.delete()
      video = null
    },
  }
}

export type Session = Awaited<ReturnType<typeof createSession>>
