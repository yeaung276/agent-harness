import { Browser } from '../browser.js'
import { CodeHarnessError } from '../errors.js'
import { Sandbox, type SandboxOptions, type Workspace } from './sandbox.js'

const API_PREFIX = '/api/v1'

export interface ClientOptions {
  baseUrl?: string
  token?: string
  fetch?: typeof fetch
}

export interface CreateSandboxOptions extends SandboxOptions {
  name?: string
  env?: Record<string, string>
  network?: { allow?: string[]; deny?: string[] }
}

// everything but sandboxes, which each entry's Client adds with its own Sandbox
export class BaseClient {
  readonly baseUrl: string
  readonly #token: string
  readonly #fetch: typeof fetch

  constructor(options: ClientOptions = {}) {
    const env = typeof process === 'undefined' ? {} : process.env
    const baseUrl = options.baseUrl ?? env.CODE_HARNESS_BASE_URL
    const token = options.token ?? env.CODE_HARNESS_TOKEN
    if (!baseUrl || !token)
      throw new CodeHarnessError(
        'Pass baseUrl and token, or set CODE_HARNESS_BASE_URL and CODE_HARNESS_TOKEN',
        'AUTHENTICATION_FAILED'
      )

    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.#token = token
    this.#fetch = options.fetch ?? fetch
  }

  async me(): Promise<{ id: string; email: string }> {
    return (await this.request('GET', '/me')).json() as Promise<{ id: string; email: string }>
  }

  async createBrowser(): Promise<Browser> {
    const session = (await (await this.request('POST', '/browser', {})).json()) as { id: string }

    return new Browser(this, { id: session.id, sandboxId: null, record: false })
  }

  getBrowser(id: string): Browser {
    return new Browser(this, { id, sandboxId: null, record: false })
  }

  // Sends one call to /api/v1, a FormData body as multipart and any other as JSON, and throws CodeHarnessError unless it answers 2xx.
  async request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}` }
    const isJson = body !== undefined && !(body instanceof FormData)
    if (isJson) headers['content-type'] = 'application/json'

    let response: Response
    try {
      response = await this.#fetch(`${this.baseUrl}${API_PREFIX}${path}`, {
        method,
        headers,
        body: isJson ? JSON.stringify(body) : (body as FormData | undefined),
      })
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err))
      throw new CodeHarnessError(`Can't reach ${this.baseUrl}: ${cause.message}`, 'NETWORK_ERROR', null, cause)
    }
    if (!response.ok) throw await CodeHarnessError.fromResponse(response)

    return response
  }
}

export class Client extends BaseClient {
  async createSandbox({ name, env, network, ...options }: CreateSandboxOptions = {}): Promise<Sandbox> {
    const response = await this.request('POST', '/workspaces', {
      name: name ?? `sandbox-${Date.now()}`,
      defaultEnv: env,
      network,
    })

    return new Sandbox(this, (await response.json()) as Workspace, options)
  }

  async getSandbox(id: string, options: SandboxOptions = {}): Promise<Sandbox> {
    const response = await this.request('GET', `/workspaces/${encodeURIComponent(id)}`)

    return new Sandbox(this, (await response.json()) as Workspace, options)
  }
}
