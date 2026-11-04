import {
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileUploadResponse,
} from 'deepagents'

import type { Browser } from './browser.js'
import type { BaseClient } from './core/client.js'
import { Sandbox as CoreSandbox, type LaunchOptions, type SandboxOptions, type Workspace } from './core/sandbox.js'

export { ROOT, type LaunchOptions, type SandboxOptions, type Workspace } from './core/sandbox.js'

// deepagents' BaseSandbox over the client entry's Sandbox, which holds the calls
export class Sandbox extends BaseSandbox {
  readonly id: string
  readonly name: string
  readonly envKeys: string[]
  readonly createdAt: Date
  readonly browser: Browser
  readonly #sandbox: CoreSandbox

  constructor(client: BaseClient, workspace: Workspace, options: SandboxOptions = {}) {
    super()
    this.#sandbox = new CoreSandbox(client, workspace, options)
    this.id = this.#sandbox.id
    this.name = this.#sandbox.name
    this.envKeys = this.#sandbox.envKeys
    this.createdAt = this.#sandbox.createdAt
    this.browser = this.#sandbox.browser
  }

  execute(command: string): Promise<ExecuteResponse> {
    return this.#sandbox.execute(command)
  }

  uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    return this.#sandbox.uploadFiles(files)
  }

  downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return this.#sandbox.downloadFiles(paths)
  }

  uploadAsZip(
    zip: Blob | Uint8Array<ArrayBuffer> | ArrayBuffer,
    options: { path?: string } = {}
  ): Promise<{ path: string; files: number }> {
    return this.#sandbox.uploadAsZip(zip, options)
  }

  launch(options: LaunchOptions): Promise<{ url: string }> {
    return this.#sandbox.launch(options)
  }

  logs(options: { tail?: number } = {}): Promise<string[]> {
    return this.#sandbox.logs(options)
  }

  stop(): Promise<void> {
    return this.#sandbox.stop()
  }

  close(): Promise<void> {
    return this.#sandbox.close()
  }
}
