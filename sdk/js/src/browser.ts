import type { Client } from './client.js'
import { CodeHarnessError } from './errors.js'

export interface WaitFor {
  selector?: string
  text?: string
  timeoutMs?: number
}

export interface PageRef {
  ref: number
  tag: string
  role: string | null
  name: string
  value: string
  placeholder: string
  href: string
}

export interface Page {
  title: string
  url: string
  text: string
  refs: PageRef[]
}

export interface NavigatedPage extends Page {
  status: number | null
  error: string | null
}

export interface RunResult {
  result: unknown
  error: string | null
  durationMs: number
}

export class Browser {
  readonly sandboxId: string | null
  readonly record: boolean
  readonly #client: Client
  #id: string | null
  #creating: Promise<string> | null = null

  constructor(
    client: Client,
    { id, sandboxId, record }: { id: string | null; sandboxId: string | null; record: boolean }
  ) {
    this.#client = client
    this.#id = id
    this.sandboxId = sandboxId
    this.record = record
  }

  get id(): string | null {
    return this.#id
  }

  navigate(url: string, options: { until?: WaitFor } = {}): Promise<NavigatedPage> {
    return this.#call('navigate', { url, ...options })
  }

  read(options: { maxChars?: number; waitFor?: WaitFor } = {}): Promise<Page> {
    return this.#call('read', options)
  }

  click(ref: number, options: { waitFor?: WaitFor } = {}): Promise<Page> {
    return this.#call('click', { ref, ...options })
  }

  type(ref: number, text: string, options: { submit?: boolean; waitFor?: WaitFor } = {}): Promise<Page> {
    return this.#call('type', { ref, text, ...options })
  }

  screenshot(options: { fullPage?: boolean; waitFor?: WaitFor } = {}): Promise<{ path: string }> {
    return this.#call('screenshot', options)
  }

  run(code: string, options: { timeoutMs?: number } = {}): Promise<RunResult> {
    return this.#call('run', { code, ...options })
  }

  async close(): Promise<void> {
    if (!this.#id) return

    await this.#client.request('DELETE', `/browser/${this.#id}`).catch(err => {
      // already closed, by an earlier close or the idle sweep
      if (!(err instanceof CodeHarnessError && err.code === 'NOT_FOUND')) throw err
    })
  }

  async #call<T>(action: string, body: object): Promise<T> {
    const id = await this.#sessionId()

    return (await this.#client.request('POST', `/browser/${id}/${action}`, body)).json() as Promise<T>
  }

  // A sandbox's browser has no session until its first call; concurrent first calls share one.
  async #sessionId(): Promise<string> {
    if (this.#id) return this.#id

    this.#creating ??= this.#client
      .request('POST', '/browser', { workspaceId: this.sandboxId, record: this.record })
      .then(response => response.json() as Promise<{ id: string }>)
      .then(session => (this.#id = session.id))
      .finally(() => (this.#creating = null))

    return this.#creating
  }
}
