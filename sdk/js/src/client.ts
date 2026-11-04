import { BaseClient, type CreateSandboxOptions } from './core/client.js'
import type { SandboxOptions, Workspace } from './core/sandbox.js'
import { Sandbox } from './sandbox.js'

export type { ClientOptions, CreateSandboxOptions } from './core/client.js'

export class Client extends BaseClient {
  async createSandbox({ name, env, ...options }: CreateSandboxOptions = {}): Promise<Sandbox> {
    const response = await this.request('POST', '/workspaces', {
      name: name ?? `sandbox-${Date.now()}`,
      defaultEnv: env,
    })

    return new Sandbox(this, (await response.json()) as Workspace, options)
  }

  async getSandbox(id: string, options: SandboxOptions = {}): Promise<Sandbox> {
    const response = await this.request('GET', `/workspaces/${encodeURIComponent(id)}`)

    return new Sandbox(this, (await response.json()) as Workspace, options)
  }
}
