import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// keepExisting: a venv is often made before its manifest, so one already in the workspace is used instead of hidden
const RULES: { manifests: string[]; deps: string; env: Record<string, string>; keepExisting?: true }[] = [
  { manifests: ['package.json'], deps: 'node_modules', env: {} },
  { manifests: ['composer.json'], deps: 'vendor', env: {} },
  { manifests: ['pyproject.toml', 'requirements.txt'], deps: '.venv', env: {}, keepExisting: true },
  { manifests: ['Gemfile'], deps: 'vendor/bundle', env: { BUNDLE_PATH: 'vendor/bundle' } },
]
const MAX_DEPTH = 3
const HOME = '/workspace/.home'
const GITCONFIG = '[user]\n\tname = Sandbox\n\temail = sandbox@localhost\n'

export type Mount = { source: string; target: string; readOnly?: true }

export const depsCache = (root: string) => ({
  mounts: async (workspaceId: string, dir: string) => {
    const mounts: Mount[] = []
    const env: Record<string, string> = {}

    const visit = async (path: string, depth: number) => {
      const entries = await readdir(join(dir, path), { withFileTypes: true }).catch(() => [])

      for (const rule of RULES) {
        if (!entries.some(entry => entry.isFile() && rule.manifests.includes(entry.name))) continue
        if (rule.keepExisting && (await readdir(join(dir, path, rule.deps)).catch(() => [])).length > 0) continue

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

    // /home bind mount
    const home = join(root, workspaceId, '.home')
    // npx reads the npm prefix's lib folder and fails when it's missing
    await mkdir(join(home, '.local', 'lib'), { recursive: true })
    await writeFile(join(home, '.gitconfig'), GITCONFIG, { flag: 'wx' }).catch(err => {
      if (err.code !== 'EEXIST') throw err
    })
    mounts.push({ source: home, target: '.home' })

    // /tmp bind mount
    const tmp = join(root, workspaceId, '.tmp')
    await mkdir(tmp, { recursive: true })
    mounts.push({ source: tmp, target: '/tmp' })

    // env
    env.HOME = HOME
    env.PATH = `${HOME}/.local/bin:${process.env.PATH}`
    env.PIP_ROOT_USER_ACTION = 'ignore'
    env.NPM_CONFIG_PREFIX = `${HOME}/.local`
    env.LANG = 'C.UTF-8'

    return { mounts, env }
  },

  remove: (workspaceId: string) => rm(join(root, workspaceId), { recursive: true, force: true }),
})
