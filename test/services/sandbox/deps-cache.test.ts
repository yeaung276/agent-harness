import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { depsCache } from '../../../src/services/sandbox/deps-cache.ts'

const root = await mkdtemp(join(tmpdir(), 'deps-cache-'))
const cache = depsCache(join(root, 'deps'))

afterAll(() => rm(root, { recursive: true, force: true }))

const workspace = async (files: Record<string, string>) => {
  const id = crypto.randomUUID()
  const dir = join(root, 'workspaces', id)
  await mkdir(dir, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return { id, dir }
}

const targets = async ({ id, dir }: { id: string; dir: string }) =>
  (await cache.mounts(id, dir)).mounts.map(({ target }) => target).sort()

describe('mounts', () => {
  test("gives a Node workspace its node_modules from the workspace's own cache folder, made ready to mount", async () => {
    const { id, dir } = await workspace({ 'package.json': '{}' })

    const { mounts, env } = await cache.mounts(id, dir)

    expect(mounts).toEqual([{ source: join(root, 'deps', id, 'node_modules'), target: 'node_modules' }])
    expect(env).toEqual({})
    expect(existsSync(mounts[0]!.source)).toBe(true)
    expect(existsSync(join(dir, 'node_modules'))).toBe(false)
  })

  test('picks the deps folder, and any env it needs, from the manifest it finds', async () => {
    const cases: { manifest: string; target: string; env: Record<string, string> }[] = [
      { manifest: 'composer.json', target: 'vendor', env: {} },
      { manifest: 'pyproject.toml', target: '.venv', env: {} },
      { manifest: 'requirements.txt', target: '.venv', env: {} },
      { manifest: 'Gemfile', target: 'vendor/bundle', env: { BUNDLE_PATH: 'vendor/bundle' } },
    ]

    for (const { manifest, target, env } of cases) {
      const { id, dir } = await workspace({ [manifest]: '' })

      const found = await cache.mounts(id, dir)

      expect(found.mounts.map(mount => mount.target)).toEqual([target])
      expect(found.env).toEqual(env)
    }
  })

  test('mounts vendor before vendor/bundle when a folder has both composer.json and a Gemfile', async () => {
    const { id, dir } = await workspace({ 'composer.json': '{}', Gemfile: '' })

    expect((await cache.mounts(id, dir)).mounts.map(mount => mount.target)).toEqual(['vendor', 'vendor/bundle'])
  })

  test('mounts the deps of every package in a monorepo, down to three folders deep', async () => {
    const ws = await workspace({
      'package.json': '{}',
      'apps/web/package.json': '{}',
      'services/api/composer.json': '{}',
      'a/b/c/package.json': '{}',
      'a/b/c/d/package.json': '{}',
    })

    expect(await targets(ws)).toEqual([
      'a/b/c/node_modules',
      'apps/web/node_modules',
      'node_modules',
      'services/api/vendor',
    ])
  })

  test('never looks inside deps folders, hidden folders or links', async () => {
    const outside = await workspace({ 'package.json': '{}' })
    const ws = await workspace({
      'node_modules/react/package.json': '{}',
      'vendor/monolog/composer.json': '{}',
      '.git/package.json': '{}',
    })
    await symlink(outside.dir, join(ws.dir, 'linked'))
    await symlink(join(outside.dir, 'package.json'), join(ws.dir, 'package.json'))

    expect(await targets(ws)).toEqual([])
  })

  test('gives nothing to a workspace without a manifest, or without a folder', async () => {
    const empty = await workspace({ 'index.html': '' })

    expect(await cache.mounts(empty.id, empty.dir)).toEqual({ mounts: [], env: {} })
    expect(await cache.mounts('gone', join(root, 'workspaces', 'gone'))).toEqual({ mounts: [], env: {} })
  })

  test("keeps each workspace's deps apart", async () => {
    const first = await workspace({ 'package.json': '{}' })
    const second = await workspace({ 'package.json': '{}' })

    const [a] = (await cache.mounts(first.id, first.dir)).mounts
    const [b] = (await cache.mounts(second.id, second.dir)).mounts

    expect(a!.source).not.toBe(b!.source)
  })
})

describe('remove', () => {
  test("deletes the workspace's cache and no other, and is fine when there is none", async () => {
    const first = await workspace({ 'package.json': '{}' })
    const second = await workspace({ 'package.json': '{}' })
    const [a] = (await cache.mounts(first.id, first.dir)).mounts
    const [b] = (await cache.mounts(second.id, second.dir)).mounts

    await cache.remove(first.id)
    await cache.remove(first.id)

    expect(existsSync(join(root, 'deps', first.id))).toBe(false)
    expect(existsSync(a!.source)).toBe(false)
    expect(existsSync(b!.source)).toBe(true)
  })
})
