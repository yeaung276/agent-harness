import { Browser } from '../browser.js'
import { CodeHarnessError } from '../errors.js'
import type { BaseClient } from './client.js'

export const ROOT = '/workspace'
const DEFAULT_TIMEOUT_MS = 120_000
const UTF8 = new TextDecoder('utf-8', { fatal: true })

// the same shapes as deepagents' sandbox protocol
export type FileOperationError = 'file_not_found' | 'permission_denied' | 'is_directory' | 'invalid_path'

export interface ExecuteResponse {
  output: string
  exitCode: number | null
  truncated: boolean
}

export interface FileUploadResponse {
  path: string
  error: FileOperationError | null
}

export interface FileDownloadResponse {
  path: string
  content: Uint8Array | null
  error: FileOperationError | null
}

export interface SandboxOptions {
  timeoutMs?: number
  record?: boolean
}

export interface LaunchOptions {
  command: string
  port: number
  env?: Record<string, string>
}

export interface Workspace {
  id: string
  name: string
  defaultEnvKeys: string[]
  createdAt: string
}

interface ExecResult {
  exitCode: number | null
  output: string
  timedOut: boolean
}

// /workspace/src/a.ts or src/a.ts → src/a.ts, /workspace → ''; null for a path outside /workspace
const relativePath = (path: string) => {
  if (path === ROOT) return ''

  return path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : path.startsWith('/') ? null : path
}

const encodePath = (relative: string) => relative.split('/').map(encodeURIComponent).join('/')

// a file route's answer for one path; anything else, like a 401, isn't about the path and is thrown
const fileError = (err: unknown): FileOperationError => {
  if (err instanceof CodeHarnessError && err.code === 'NOT_FOUND') return 'file_not_found'
  if (err instanceof CodeHarnessError && err.code === 'INVALID_REQUEST') return 'invalid_path'
  throw err
}

export class Sandbox {
  readonly id: string
  readonly name: string
  readonly envKeys: string[]
  readonly createdAt: Date
  readonly browser: Browser
  readonly #client: BaseClient
  readonly #timeoutMs: number

  constructor(
    client: BaseClient,
    workspace: Workspace,
    { timeoutMs = DEFAULT_TIMEOUT_MS, record = false }: SandboxOptions = {}
  ) {
    this.#client = client
    this.#timeoutMs = timeoutMs
    this.id = workspace.id
    this.name = workspace.name
    this.envKeys = workspace.defaultEnvKeys
    this.createdAt = new Date(workspace.createdAt)
    this.browser = new Browser(client, { id: null, sandboxId: workspace.id, record })
  }

  async execute(command: string): Promise<ExecuteResponse> {
    const response = await this.#client.request('POST', `/workspaces/${this.id}/sandbox/exec`, {
      command,
      timeoutMs: this.#timeoutMs,
    })
    const result = (await response.json()) as ExecResult

    return {
      output: result.timedOut ? `${result.output}\ntimed out after ${this.#timeoutMs} ms` : result.output,
      exitCode: result.exitCode,
      truncated: false,
    }
  }

  async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    const results: FileUploadResponse[] = []
    for (const [path, bytes] of files) {
      const relative = relativePath(path)
      if (!relative) {
        results.push({ path, error: 'invalid_path' })
        continue
      }
      let content: string
      try {
        content = UTF8.decode(bytes)
      } catch {
        // the files route takes text only
        results.push({ path, error: 'invalid_path' })
        continue
      }

      const error = await this.#client
        .request('PUT', `/workspaces/${this.id}/files/${encodePath(relative)}`, { content })
        .then(() => null, fileError)
      results.push({ path, error })
    }

    return results
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const results: FileDownloadResponse[] = []
    for (const path of paths) {
      const relative = relativePath(path)
      if (!relative) {
        results.push({ path, content: null, error: 'invalid_path' })
        continue
      }

      try {
        const response = await this.#client.request(
          'GET',
          `/workspaces/${this.id}/files/${encodePath(relative)}?raw=true`
        )
        results.push({ path, content: new Uint8Array(await response.arrayBuffer()), error: null })
      } catch (err) {
        results.push({ path, content: null, error: fileError(err) })
      }
    }

    return results
  }

  async uploadAsZip(
    zip: Blob | Uint8Array<ArrayBuffer> | ArrayBuffer,
    { path = '' }: { path?: string } = {}
  ): Promise<{ path: string; files: number }> {
    const relative = relativePath(path)
    if (relative === null) throw new CodeHarnessError(`${path} is outside ${ROOT}`, 'INVALID_REQUEST')

    const form = new FormData()
    form.append('path', relative)
    form.append('file', zip instanceof Blob ? zip : new Blob([zip]), 'upload.zip')

    return (await this.#client.request('PUT', `/workspaces/${this.id}/upload`, form)).json() as Promise<{
      path: string
      files: number
    }>
  }

  async readFile(
    path: string,
    { offset, limit }: { offset?: number; limit?: number } = {}
  ): Promise<{ content: string; totalLines: number }> {
    const query = new URLSearchParams()
    if (offset !== undefined) query.set('offset', String(offset))
    if (limit !== undefined) query.set('limit', String(limit))

    const suffix = query.size ? `?${query}` : ''
    const response = await this.#client.request('GET', `/workspaces/${this.id}/files/${encodePath(path)}${suffix}`)

    return response.json() as Promise<{ content: string; totalLines: number }>
  }

  async editFile(path: string, search: string, replace: string): Promise<void> {
    await this.#client.request('PATCH', `/workspaces/${this.id}/files/${encodePath(path)}`, { search, replace })
  }

  async tree(path = ''): Promise<string[]> {
    const query = new URLSearchParams({ path })
    const response = await this.#client.request('GET', `/workspaces/${this.id}/tree?${query}`)

    return ((await response.json()) as { paths: string[] }).paths
  }

  async launch(options: LaunchOptions): Promise<{ url: string }> {
    return (await this.#client.request('POST', `/workspaces/${this.id}/sandbox/launch`, options)).json() as Promise<{
      url: string
    }>
  }

  async logs({ tail }: { tail?: number } = {}): Promise<string[]> {
    const query = tail === undefined ? '' : `?tail=${tail}`
    const response = await this.#client.request('GET', `/workspaces/${this.id}/sandbox/logs${query}`)

    return ((await response.json()) as { lines: string[] }).lines
  }

  async stop(): Promise<void> {
    await this.#client.request('POST', `/workspaces/${this.id}/sandbox/stop`)
  }

  async close(): Promise<void> {
    await this.browser.close()
    await this.#client.request('DELETE', `/workspaces/${this.id}`)
  }
}
