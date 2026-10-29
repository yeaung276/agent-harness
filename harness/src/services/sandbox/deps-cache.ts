import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const RULES: { manifests: string[]; deps: string; env: Record<string, string> }[] = [
  { manifests: ['package.json'], deps: 'node_modules', env: {} },
  { manifests: ['composer.json'], deps: 'vendor', env: {} },
  { manifests: ['pyproject.toml', 'requirements.txt'], deps: '.venv', env: {} },
  { manifests: ['Gemfile'], deps: 'vendor/bundle', env: { BUNDLE_PATH: 'vendor/bundle' } },
]
const MAX_DEPTH = 3

export type Mount = { source: string; target: string; readOnly?: true }

export const depsCache = (root: string) => ({
  mounts: async (workspaceId: string, dir: string) => {
    const mounts: Mount[] = []
    const env: Record<string, string> = {}

    const visit = async (path: string, depth: number) => {
      const entries = await readdir(join(dir, path), { withFileTypes: true }).catch(() => [])

      for (const rule of RULES) {
        if (!entries.some(entry => entry.isFile() && rule.manifests.includes(entry.name))) continue

        const source = join(root, workspaceId, path, rule.deps)
        await mkdir(source, { recursive: true })
        mounts.push({ source, target: join(path, rule.deps) })
        Object.assign(env, rule.env)
      }

      if (depth === MAX_DEPTH) return

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || RULES.some(({ deps }) => deps === entry.name))
          continue

        await visit(join(path, entry.name), depth + 1)
      }
    }

    await visit('', 0)

    return { mounts, env }
  },

  remove: (workspaceId: string) => rm(join(root, workspaceId), { recursive: true, force: true }),
})
