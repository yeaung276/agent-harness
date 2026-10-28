import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path'

import { HttpError } from '../http-error.ts'

const IGNORED = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'coverage'])

export const isIgnored = (name: string) => IGNORED.has(name)

export const isSecret = (name: string) => /^\.env(\..+)?$/.test(name) && name !== '.env.example'

export const isInside = async (root: string, target: string) => {
  let existing = target
  while (!(await lstat(existing).catch(() => null))) existing = dirname(existing)
  const relativePath = relative(await realpath(root), await realpath(existing))
  return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

export const ensureFolder = async (target: string, path: string) => {
  const info = await stat(target).catch(() => null)
  if (!info) throw new HttpError(404, `${path} not found`)
  if (!info.isDirectory()) throw new HttpError(400, `${path} is a file`)
}

export const ensureFile = async (target: string, path: string) => {
  const info = await stat(target).catch(() => null)
  if (!info) throw new HttpError(404, `${path} not found`)
  if (!info.isFile()) throw new HttpError(400, `${path} is a folder`)
}

export const walk = async (
  dir: string,
  prefix: string,
  options: { secrets: boolean; recursive: boolean }
): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(
    entries
      .filter(entry => !isIgnored(entry.name) && (options.secrets || !isSecret(entry.name)))
      .map(async entry => {
        const path = posix.join(prefix, entry.name)
        if (!entry.isDirectory()) return [path]
        if (!options.recursive) return [`${path}/`]
        return [`${path}/`, ...(await walk(join(dir, entry.name), path, options))]
      })
  )
  return paths.flat()
}

export const isBinary = (bytes: Uint8Array) => bytes.subarray(0, 8192).includes(0)
