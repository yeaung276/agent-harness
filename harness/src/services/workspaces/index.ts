import * as fs from 'node:fs/promises'
import { mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { desc, eq, sql } from 'drizzle-orm'

import { users, workspaces } from '../../db/schema.ts'
import type { Db } from '../../db/type.ts'
import { logger } from '../../logger.ts'
import { HttpError } from '../http-error.ts'
import { depsCache } from '../sandbox/deps-cache.ts'
import { decrypt, encrypt } from './crypto.ts'
import { ensureFile, ensureFolder, isBinary, isInside, walk } from './files.ts'
import { checkZip, extractZip } from './zip.ts'

const log = logger('workspaces-service')

// 1–63 lowercase letters, digits and -, not starting or ending with -
export const NAME_PATTERN = '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'

export const createWorkspaceService = ({
  db,
  dir,
  depsRoot,
  dataEncryptionKey,
}: {
  db: Db
  dir: string
  depsRoot: string
  dataEncryptionKey: string
}) => {
  const path = (id: string) => join(resolve(dir), id)
  const trash = (id: string) => join(resolve(dir), '.deleted', id)
  const uploadsDir = join(resolve(dir), '.uploads')
  const deps = depsCache(depsRoot)

  const select = () =>
    db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        status: workspaces.status,
        defaultEnvKeys: sql<string[]>`array(select jsonb_object_keys(${workspaces.defaultEnv}) order by 1)`,
        createdBy: { id: users.id, email: users.email },
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
      })
      .from(workspaces)
      .innerJoin(users, eq(users.id, workspaces.userId))

  const getOrThrow = async (id: string) => {
    const [workspace] = await select().where(eq(workspaces.id, id))
    if (!workspace) throw new HttpError(404, 'Workspace not found')
    return workspace
  }

  const resolvePath = async (id: string, subpath: string) => {
    await getOrThrow(id)
    const target = resolve(path(id), subpath)
    if (!(await isInside(path(id), target))) throw new HttpError(404, `${subpath} not found`)
    return target
  }

  const encryptEnv = (newEnv: Record<string, string | null>, existingEnv: Record<string, string> = {}) => {
    const merged = { ...existingEnv }
    for (const [key, value] of Object.entries(newEnv)) {
      if (value === null) delete merged[key]
      else merged[key] = encrypt(dataEncryptionKey, value)
    }
    return merged
  }

  const decryptEnv = (existingEnv: Record<string, string>) =>
    Object.fromEntries(Object.entries(existingEnv).map(([key, value]) => [key, decrypt(dataEncryptionKey, value)]))

  return {
    uploadsDir,

    // Workspaces
    create: async (userId: string, name: string, defaultEnv: Record<string, string> = {}) => {
      if (!new RegExp(NAME_PATTERN).test(name))
        throw new HttpError(400, 'Use 1–63 lowercase letters, digits and -, not starting or ending with -')

      const created = await db.transaction(async tx => {
        const [row] = await tx
          .insert(workspaces)
          .values({ userId, name, defaultEnv: encryptEnv(defaultEnv) })
          .onConflictDoNothing({ target: workspaces.name })
          .returning({ id: workspaces.id })
        if (row) await mkdir(path(row.id), { recursive: true })
        return row
      })
      if (!created) throw new HttpError(409, 'A workspace already has this name')
      log.info({ workspaceId: created.id, name, userId }, 'workspace created')

      return getOrThrow(created.id)
    },

    get: getOrThrow,

    list: async ({ limit, offset }: { limit: number; offset: number }) => {
      const [items, total] = await Promise.all([
        select().orderBy(desc(workspaces.createdAt), desc(workspaces.id)).limit(limit).offset(offset),
        db.$count(workspaces),
      ])
      return { items, total }
    },

    update: async (id: string, { defaultEnv = {} }: { defaultEnv?: Record<string, string | null> }) => {
      await db.transaction(async tx => {
        const [row] = await tx
          .select({ defaultEnv: workspaces.defaultEnv })
          .from(workspaces)
          .where(eq(workspaces.id, id))
          .for('update')
        if (!row) throw new HttpError(404, 'Workspace not found')

        await tx
          .update(workspaces)
          .set({ defaultEnv: encryptEnv(defaultEnv, row.defaultEnv), updatedAt: sql`now()` })
          .where(eq(workspaces.id, id))
      })
      log.info({ workspaceId: id, keys: Object.keys(defaultEnv) }, 'workspace env changed')
    },

    delete: async (id: string) => {
      await db.transaction(async tx => {
        const [row] = await tx.delete(workspaces).where(eq(workspaces.id, id)).returning({ id: workspaces.id })
        if (!row) throw new HttpError(404, 'Workspace not found')

        await mkdir(join(resolve(dir), '.deleted'), { recursive: true })
        await rename(path(id), trash(id)).catch(err => {
          if (err.code !== 'ENOENT') throw err
        })
      })
      log.info({ workspaceId: id }, 'workspace deleted')

      rm(trash(id), { recursive: true, force: true }).catch(err =>
        log.error({ err, id }, 'failed to remove deleted workspace files')
      )
      deps.remove(id).catch(err => log.error({ err, id }, 'failed to remove deleted workspace deps'))
    },

    extract: async (id: string, { zip, path: folder }: { zip: string; path: string }) => {
      const root = path(id)
      const target = resolve(root, folder.replace(/^\/+/, ''))
      const relativePath = relative(root, target)

      let accepted = false
      let files: number
      try {
        await getOrThrow(id)
        if (!(await isInside(root, target))) throw new HttpError(400, 'path leads outside the workspace')
        if ((await stat(target).catch(() => null))?.isFile()) throw new HttpError(400, `${relativePath} is a file`)
        files = await checkZip(zip)
        accepted = true
      } finally {
        if (!accepted) await rm(zip, { force: true })
      }

      mkdir(target, { recursive: true })
        .then(() => extractZip(zip, target))
        .then(() => db.update(workspaces).set({ updatedAt: sql`now()` }).where(eq(workspaces.id, id)))
        .then(() => log.info({ workspaceId: id, path: relativePath, files }, 'upload extracted'))
        .catch(err => log.error({ err, id }, 'failed to extract upload'))
        .then(() => rm(zip, { force: true }))
        .catch(err => log.error({ err, zip }, 'failed to remove upload'))

      return { path: relativePath, files }
    },

    // Files
    tree: async (id: string, path: string, options: { secrets: boolean; recursive: boolean }) => {
      const dir = await resolvePath(id, path)
      await ensureFolder(dir, path)
      return (await walk(dir, path, options)).sort()
    },

    describeFile: async (id: string, path: string) => {
      const info = await stat(await resolvePath(id, path)).catch(() => null)
      if (!info) throw new HttpError(404, `${path} not found`)
      return {
        name: basename(path),
        path,
        type: info.isDirectory() ? ('directory' as const) : ('file' as const),
        size: info.size,
        updatedAt: info.mtime,
      }
    },

    readFile: async (id: string, path: string) => {
      const target = await resolvePath(id, path)
      await ensureFile(target, path)
      return fs.readFile(target)
    },

    writeFile: async (id: string, path: string, content: string) => {
      const target = await resolvePath(id, path)
      if ((await stat(target).catch(() => null))?.isDirectory()) throw new HttpError(400, `${path} is a folder`)
      await mkdir(dirname(target), { recursive: true }).catch(err => {
        if (err.code !== 'EEXIST' && err.code !== 'ENOTDIR') throw err
        throw new HttpError(400, `A folder on the way to ${path} is a file`)
      })
      await fs.writeFile(target, content)
    },

    editFile: async (id: string, path: string, search: string, replace: string) => {
      const target = await resolvePath(id, path)
      await ensureFile(target, path)
      const bytes = await fs.readFile(target)
      if (isBinary(bytes)) throw new HttpError(400, `${path} is binary`)
      const parts = bytes.toString().split(search)
      if (parts.length === 1) throw new HttpError(400, `search is not in ${path}`)
      if (parts.length > 2) throw new HttpError(409, `search is in ${path} ${parts.length - 1} times`)
      await fs.writeFile(target, parts.join(replace))
    },

    deleteFile: async (id: string, path: string) => {
      const target = await resolvePath(id, path)
      await ensureFile(target, path)
      await unlink(target)
    },

    // Utilities
    removeLeftovers: async () => {
      const leftovers = await Promise.all(
        [join(resolve(dir), '.deleted'), uploadsDir].map(async folder => {
          const names = await readdir(folder).catch(err => {
            if (err.code !== 'ENOENT') log.error({ err, folder }, 'failed to read leftover workspace files')
            return []
          })
          return names.map(name => join(folder, name))
        })
      )
      await Promise.all(
        leftovers.flat().map(leftover =>
          rm(leftover, { recursive: true, force: true }).catch(err =>
            log.error({ err, leftover }, 'failed to remove leftover workspace files')
          )
        )
      )
    },

    getWorkspaceRoot: path,

    getDefaultEnv: async (id: string) => {
      const [row] = await db.select({ defaultEnv: workspaces.defaultEnv }).from(workspaces).where(eq(workspaces.id, id))
      if (!row) throw new HttpError(404, 'Workspace not found')
      return decryptEnv(row.defaultEnv)
    },

    setStatus: async (id: string, status: 'running' | 'stopped') => {
      await db.update(workspaces).set({ status }).where(eq(workspaces.id, id))
    },

    setLaunchOptions: async (id: string, options: typeof workspaces.$inferSelect.launchOptions) => {
      await db
        .update(workspaces)
        .set({ launchOptions: options && { ...options, env: encryptEnv(options.env) } })
        .where(eq(workspaces.id, id))
    },

    getLaunchOptions: async (id: string) => {
      const [row] = await db
        .select({ launchOptions: workspaces.launchOptions })
        .from(workspaces)
        .where(eq(workspaces.id, id))
      if (!row?.launchOptions) return null
      return { ...row.launchOptions, env: decryptEnv(row.launchOptions.env) }
    },
  }
}
