import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HttpError } from '../../../src/services/http-error.ts'
import type { RunResult } from '../../../src/services/chromium/runner.ts'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => (resolve = res))
  return { promise, resolve }
}

const ok = (result: unknown): RunResult => ({ result, error: null, timedOut: false, durationMs: 1 })
const failed = (error: string): RunResult => ({ result: null, error, timedOut: false, durationMs: 1 })
const timedOut: RunResult = { result: null, error: 'timed out after 1 s', timedOut: true, durationMs: 1000 }

let connected = false
let starts = 0
let onExit: (() => void)[] = []
let runs: { targetId: string; code: string; timeoutMs: number }[] = []
let next: (RunResult | Promise<RunResult>)[] = []
let tabs: ReturnType<typeof fakeTab>[] = []
let targets = 0

const fakeTab = (options: {
  record: boolean
  getWorkspaceAccessPort?: () => number | null
  url: string | null
  storageState: unknown
}) => {
  const tab = {
    options,
    targetId: `target-${targets++}`,
    open: true,
    idle: false,
    closes: 0,
    exportedTo: [] as string[],

    isOpen: () => tab.open,
    state: async () => ({ url: '/orders', storageState: { cookies: [], origins: [] } }),
    use: () => () => {},
    isIdle: () => tab.idle,
    close: async () => {
      tab.closes++
      tab.open = false
    },
    exportRecording: async (path: string) => {
      tab.exportedTo.push(path)
    },
  }
  return tab
}

mock.module('../../../src/services/chromium/chromium.ts', () => ({
  createChromium: () => ({
    start: async () => {
      starts++
      connected = true
    },
    stop: async () => {
      connected = false
    },
    connect: async () => ({ isConnected: () => connected }),
    onExit: (handler: () => void) => onExit.push(handler),
  }),
}))

mock.module('../../../src/services/chromium/runner.ts', () => ({
  createRunner: () => ({
    exec: async (targetId: string, code: string, timeoutMs: number) => {
      runs.push({ targetId, code, timeoutMs })
      return next.shift() ?? ok({ title: 'page', url: 'http://x/', text: '', refs: [] })
    },
  }),
}))

mock.module('../../../src/services/chromium/session.ts', () => ({
  WORKSPACE_ORIGIN: /^http:\/\/127\.0\.0\.1:\d+(?=\/)/,
  createSession: async (_browser: unknown, options: Parameters<typeof fakeTab>[0]) => {
    const tab = fakeTab(options)
    tabs.push(tab)
    return tab
  },
}))

const { createChromiumManager } = await import('../../../src/services/chromium/manager.ts')

type Deps = Parameters<typeof createChromiumManager>[0]
type BrowserSession = Awaited<ReturnType<Deps['browsers']['create']>>

const root = await mkdtemp(join(tmpdir(), 'chromium-manager-'))
afterAll(() => rm(root, { recursive: true, force: true }))

const workspaceRoot = (id: string) => join(root, id)

const fakeBrowsers = () => {
  const rows = new Map<string, BrowserSession>()

  return {
    rows,
    create: async (userId: string, { workspaceId, record }: { workspaceId: string | null; record: boolean }) => {
      const now = new Date()
      const row: BrowserSession = {
        id: crypto.randomUUID(),
        workspaceId,
        record,
        status: 'alive',
        url: null,
        storageState: null,
        userId,
        lastUsedAt: now,
        createdAt: now,
      }
      rows.set(row.id, row)
      return { ...row }
    },
    get: async (id: string) => {
      const row = rows.get(id)
      return row ? { ...row } : null
    },
    update: async (id: string, values: Partial<BrowserSession>) => {
      const row = rows.get(id)
      if (!row) return
      for (const [key, value] of Object.entries(values)) if (value !== undefined) Object.assign(row, { [key]: value })
      row.lastUsedAt = new Date()
    },
  }
}

const fakeActivities = () => {
  const rows: { browserId: string; kind: string; command: string; result: unknown; error: string | null }[] = []

  return {
    rows,
    record: async (
      browserId: string,
      kind: string,
      command: string,
      { result, error }: { result: unknown; error: string | null }
    ) => {
      rows.push({ browserId, kind, command, result, error })
    },
  }
}

const fakePlacement = () => {
  const told: string[] = []

  return {
    told,
    claimSession: async (id: string) => {
      told.push(`claim ${id}`)
    },
    releaseSession: async (id: string) => {
      told.push(`release ${id}`)
    },
  }
}

const hostPorts = new Map<string, number>()
let browsers: ReturnType<typeof fakeBrowsers>
let activities: ReturnType<typeof fakeActivities>
let placement: ReturnType<typeof fakePlacement>
let manager: ReturnType<typeof createChromiumManager>

const tabOf = (index: number) => tabs[index]!

beforeEach(async () => {
  connected = false
  starts = 0
  onExit = []
  runs = []
  next = []
  tabs = []
  hostPorts.clear()
  browsers = fakeBrowsers()
  activities = fakeActivities()
  placement = fakePlacement()

  manager = createChromiumManager({
    workspaces: {
      get: async (id: string) => {
        if (id !== 'ws-1') throw new HttpError(404, 'Workspace not found')
      },
      getWorkspaceRoot: workspaceRoot,
    } as unknown as Deps['workspaces'],
    sandboxes: { hostPort: (id: string) => hostPorts.get(id) ?? null } as unknown as Deps['sandboxes'],
    browsers: browsers as unknown as Deps['browsers'],
    activities: activities as unknown as Deps['activities'],
    placement: placement as unknown as Deps['placement'],
    mode: 'none',
    portMin: 4100,
    portMax: 4149,
    idleMs: 60_000,
  })
  await manager.start()
})

afterEach(() => manager.stopAll())

describe('create', () => {
  test('inserts the row and opens its tab at once', async () => {
    const created = await manager.create('user-1', { workspaceId: 'ws-1', record: false })

    expect(created).toMatchObject({ workspaceId: 'ws-1', record: false, status: 'alive', userId: 'user-1' })
    expect(browsers.rows.has(created.id)).toBe(true)
    expect(tabs).toHaveLength(1)
  })

  test('refuses record without a workspace, an unknown workspace, and a browser that is down', async () => {
    await expect(manager.create('user-1', { workspaceId: null, record: true })).rejects.toMatchObject({ status: 400 })
    await expect(manager.create('user-1', { workspaceId: 'ws-9', record: false })).rejects.toMatchObject({
      status: 404,
    })

    connected = false
    await expect(manager.create('user-1', { workspaceId: null, record: false })).rejects.toMatchObject({
      status: 503,
    })
    expect(tabs).toHaveLength(0)
    expect(browsers.rows.size).toBe(0)
  })

  test('refuses a 31st tab on the worker with a 429, and makes no row for it', async () => {
    for (let i = 0; i < 30; i++) await manager.create('user-1', { workspaceId: null, record: false })

    await expect(manager.create('user-1', { workspaceId: null, record: false })).rejects.toMatchObject({
      status: 429,
      message: 'Too many sessions are open on this worker',
    })
    expect(tabs).toHaveLength(30)
    expect(browsers.rows.size).toBe(30)
  })

  test("gives the tab its workspace's port as it is at each request, and none without a workspace", async () => {
    await manager.create('user-1', { workspaceId: 'ws-1', record: false })
    await manager.create('user-1', { workspaceId: null, record: false })

    expect(tabOf(0).options.getWorkspaceAccessPort?.()).toBeNull()
    hostPorts.set('ws-1', 4120)
    expect(tabOf(0).options.getWorkspaceAccessPort?.()).toBe(4120)
    expect(tabOf(1).options.getWorkspaceAccessPort).toBeUndefined()
  })
})

describe('a call', () => {
  test('runs on its tab by target id, and saves where the tab is and its cookies to the row', async () => {
    const { id } = await manager.create('user-1', { workspaceId: null, record: false })

    await manager.read(id)

    expect(runs[0]?.targetId).toBe(tabOf(0).targetId)
    expect(browsers.rows.get(id)).toMatchObject({
      url: '/orders',
      storageState: { cookies: [], origins: [] },
    })
  })

  test('runs one call at a time per session, in the order they came', async () => {
    const { id } = await manager.create('user-1', { workspaceId: null, record: false })
    const slow = deferred<RunResult>()
    next.push(slow.promise)

    const first = manager.run(id, 'first', 30_000)
    const second = manager.run(id, 'second', 30_000)
    await Bun.sleep(50)
    expect(runs.map(run => run.code)).toEqual(['first'])

    slow.resolve(ok('done'))
    await Promise.all([first, second])
    expect(runs.map(run => run.code)).toEqual(['first', 'second'])
  })

  test("navigate opens a path on the workspace's running port", async () => {
    const { id } = await manager.create('user-1', { workspaceId: 'ws-1', record: false })
    hostPorts.set('ws-1', 4120)

    await manager.navigate(id, '/orders')

    expect(runs[0]?.code).toContain('http://127.0.0.1:4120/orders')
  })

  test("answers the workspace's pages and links as paths, and other sites as they are", async () => {
    const { id } = await manager.create('user-1', { workspaceId: 'ws-1', record: false })
    const page = {
      title: 'Orders',
      url: 'http://127.0.0.1:4120/orders?id=7',
      text: '',
      refs: [{ href: 'http://127.0.0.1:4120/cart' }, { href: 'https://example.com/' }, { href: '' }],
    }

    next.push(ok({ ...page, status: 200, error: null }))
    expect(await manager.navigate(id, '/orders?id=7')).toMatchObject({
      url: '/orders?id=7',
      refs: [{ href: '/cart' }, { href: 'https://example.com/' }, { href: '' }],
    })

    next.push(ok({ ...page, url: 'https://example.com/a' }))
    expect(await manager.read(id)).toMatchObject({ url: 'https://example.com/a' })
  })

  test('gives the call 60 s plus what waitFor may wait', async () => {
    const { id } = await manager.create('user-1', { workspaceId: null, record: false })

    await manager.read(id)
    await manager.click(id, 1, { selector: '#done', timeoutMs: 20_000 })
    await manager.navigate(id, 'https://example.com/', { text: 'Ready', timeoutMs: 5000 })

    expect(runs.map(run => run.timeoutMs)).toEqual([60_000, 80_000, 65_000])
  })

  test("answers our ops' failures with HTTP errors, and a run with its own error", async () => {
    const { id } = await manager.create('user-1', { workspaceId: null, record: false })

    next.push(failed('wait_for_timed_out'))
    await expect(manager.read(id, undefined, { text: 'x', timeoutMs: 1 })).rejects.toMatchObject({ status: 504 })

    next.push(failed('ref_not_found'))
    await expect(manager.click(id, 9)).rejects.toMatchObject({ status: 404 })

    next.push(failed('element is not visible'))
    await expect(manager.click(id, 1)).rejects.toMatchObject({ status: 400, message: 'element is not visible' })

    next.push(failed('boom'))
    expect(await manager.run(id, 'throw 1', 30_000)).toEqual({ result: null, error: 'boom', durationMs: 1 })
  })

  test('a call past its time answers 504 and keeps the tab; a run answers in its body', async () => {
    const { id } = await manager.create('user-1', { workspaceId: null, record: false })

    next.push(timedOut)
    await expect(manager.read(id)).rejects.toMatchObject({ status: 504 })
    expect(tabOf(0).closes).toBe(0)

    next.push(timedOut)
    expect(await manager.run(id, 'x', 1000)).toEqual({ result: null, error: 'timed out after 1 s', durationMs: 1000 })
  })

  test('says 404 for a session that does not exist', async () => {
    await expect(manager.read(crypto.randomUUID())).rejects.toMatchObject({ status: 404 })
    expect(runs).toEqual([])
  })

  test('reopens a tab that closed on its own where the row left off, and runs on it', async () => {
    const { id } = await manager.create('user-1', { workspaceId: 'ws-1', record: true })
    await manager.read(id)
    tabOf(0).open = false

    await manager.read(id)

    expect(tabOf(0).exportedTo).toHaveLength(1)
    expect(tabOf(1).options).toMatchObject({ record: true, url: '/orders' })
    expect(runs[1]?.targetId).toBe(tabOf(1).targetId)
    expect(browsers.rows.get(id)?.status).toBe('alive')
  })
})

describe('activity', () => {
  test('records each call once it ends, with what it returned or its error', async () => {
    const { id } = await manager.create('user-1', { workspaceId: null, record: false })
    const page = { title: 'Orders', url: 'http://x/orders', text: '', refs: [] }

    next.push(ok({ ...page, status: 200, error: null }))
    await manager.navigate(id, 'http://x/orders')
    next.push(failed('ref_not_found'))
    await manager.click(id, 9).catch(() => {})
    next.push(ok(42))
    await manager.run(id, 'return 42', 1000)

    expect(activities.rows).toEqual([
      {
        browserId: id,
        kind: 'navigate',
        command: 'http://x/orders',
        result: { ...page, status: 200, error: null },
        error: null,
      },
      { browserId: id, kind: 'click', command: 'ref 9', result: null, error: 'ref_not_found' },
      { browserId: id, kind: 'run', command: 'return 42', result: 42, error: null },
    ])
  })

  test('records nothing for a session that does not exist', async () => {
    await expect(manager.read(crypto.randomUUID())).rejects.toMatchObject({ status: 404 })
    expect(activities.rows).toEqual([])
  })
})

describe('screenshot', () => {
  test('is refused on a session created without record', async () => {
    const { id } = await manager.create('user-1', { workspaceId: 'ws-1', record: false })

    await expect(manager.screenshot(id, false)).rejects.toMatchObject({ status: 409 })
    expect(runs).toEqual([])
  })

  test('saves the PNG into the workspace and returns its path there', async () => {
    const { id } = await manager.create('user-1', { workspaceId: 'ws-1', record: true })
    next.push(ok({ png: Buffer.from('png bytes').toString('base64') }))

    const { path } = await manager.screenshot(id, true)

    expect(path).toMatch(new RegExp(`^screenshot/${id}-\\d+\\.png$`))
    expect(await readFile(join(workspaceRoot('ws-1'), path), 'utf8')).toBe('png bytes')
  })
})

describe('closing', () => {
  test('close closes the tab, saves where it is to the row and marks it closed', async () => {
    const { id } = await manager.create('user-1', { workspaceId: null, record: false })

    await manager.close(id)

    expect(tabOf(0).closes).toBe(1)
    expect(browsers.rows.get(id)).toMatchObject({ status: 'closed', url: '/orders' })
    await expect(manager.close(id)).rejects.toMatchObject({ status: 404 })
  })

  test('a call on a closed session reopens it where it was', async () => {
    const { id } = await manager.create('user-1', { workspaceId: null, record: false })
    await manager.close(id)

    await manager.read(id)

    expect(tabOf(1).options.url).toBe('/orders')
    expect(runs[0]?.targetId).toBe(tabOf(1).targetId)
    expect(browsers.rows.get(id)?.status).toBe('alive')
  })

  test("saves a recorded session's video into its workspace", async () => {
    const { id } = await manager.create('user-1', { workspaceId: 'ws-1', record: true })

    await manager.close(id)

    expect(tabOf(0).exportedTo).toHaveLength(1)
    expect(tabOf(0).exportedTo[0]).toMatch(new RegExp(`^${join(workspaceRoot('ws-1'), 'browser', id)}-\\d+\\.webm$`))
  })

  test('stopIdle closes only idle tabs, the same way', async () => {
    const idle = await manager.create('user-1', { workspaceId: 'ws-1', record: true })
    const busy = await manager.create('user-1', { workspaceId: null, record: false })
    tabOf(0).idle = true

    await manager.stopIdle()

    expect(browsers.rows.get(idle.id)?.status).toBe('closed')
    expect(tabOf(0).exportedTo).toHaveLength(1)
    expect(browsers.rows.get(busy.id)?.status).toBe('alive')
    expect(tabOf(1).closes).toBe(0)
  })

  test('stopAll closes every tab the same way and stops Chromium', async () => {
    const { id } = await manager.create('user-1', { workspaceId: 'ws-1', record: true })

    await manager.stopAll()

    expect(browsers.rows.get(id)?.status).toBe('closed')
    expect(tabOf(0).exportedTo).toHaveLength(1)
    expect(connected).toBe(false)
  })
})

describe('placement', () => {
  test('creating a session claims it', async () => {
    const { id } = await manager.create('user-1', { workspaceId: null, record: false })

    expect(placement.told).toEqual([`claim ${id}`])
  })

  test('a call on an open tab neither claims nor releases', async () => {
    const { id } = await manager.create('user-1', { workspaceId: null, record: false })

    await manager.read(id)

    expect(placement.told).toEqual([`claim ${id}`])
  })

  test('close releases', async () => {
    const { id } = await manager.create('user-1', { workspaceId: null, record: false })

    await manager.close(id)

    expect(placement.told).toEqual([`claim ${id}`, `release ${id}`])
  })

  test('a call on a closed session claims it again', async () => {
    const { id } = await manager.create('user-1', { workspaceId: null, record: false })
    await manager.close(id)

    await manager.read(id)

    expect(placement.told).toEqual([`claim ${id}`, `release ${id}`, `claim ${id}`])
  })

  test('a tab that closed on its own releases, and claims again as it reopens', async () => {
    const { id } = await manager.create('user-1', { workspaceId: null, record: false })
    tabOf(0).open = false

    await manager.read(id)

    expect(placement.told).toEqual([`claim ${id}`, `release ${id}`, `claim ${id}`])
  })

  test('the idle sweep releases only the idle sessions', async () => {
    const idle = await manager.create('user-1', { workspaceId: null, record: false })
    const busy = await manager.create('user-1', { workspaceId: null, record: false })
    tabOf(0).idle = true

    await manager.stopIdle()

    expect(placement.told).toEqual([`claim ${idle.id}`, `claim ${busy.id}`, `release ${idle.id}`])
  })

  test('shutting down releases every session', async () => {
    const first = await manager.create('user-1', { workspaceId: null, record: false })
    const second = await manager.create('user-1', { workspaceId: null, record: false })

    await manager.stopAll()

    expect(placement.told.filter(entry => entry.startsWith('release')).sort()).toEqual(
      [`release ${first.id}`, `release ${second.id}`].sort()
    )
  })

  test('Chromium exiting releases every session it held', async () => {
    const first = await manager.create('user-1', { workspaceId: null, record: false })
    const second = await manager.create('user-1', { workspaceId: null, record: false })

    connected = false
    for (const handler of onExit) handler()

    expect(placement.told.filter(entry => entry.startsWith('release')).sort()).toEqual(
      [`release ${first.id}`, `release ${second.id}`].sort()
    )
  })
})

describe('Chromium exiting', () => {
  test('drops the tabs, starts Chromium again, and their sessions reopen on the next call', async () => {
    const { id } = await manager.create('user-1', { workspaceId: null, record: false })

    connected = false
    for (const handler of onExit) handler()
    await expect(manager.read(id)).rejects.toMatchObject({ status: 503 })

    await Bun.sleep(1100)
    expect(starts).toBe(2)

    await manager.read(id)
    expect(runs[0]?.targetId).toBe(tabOf(1).targetId)
    expect(browsers.rows.get(id)?.status).toBe('alive')
  })
})
