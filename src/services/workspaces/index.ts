import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { desc, eq, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'

import { users, workspaces } from '../../db/schema.ts'
import type { Db } from '../../db/type.ts'
import { HttpError } from '../http-error.ts'
import { checkZip, extractZip } from './zip.ts'

// 1–63 lowercase letters, digits and -, not starting or ending with -
export const NAME_PATTERN = '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'

export const createWorkspaceService = ({ db, dir, log }: { db: Db; dir: string; log: FastifyBaseLogger }) => {
  const path = (id: string) => join(resolve(dir), id)
  const trash = (id: string) => join(resolve(dir), '.deleted', id)
  const uploadsDir = join(resolve(dir), '.uploads')

  const select = () =>
    db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        status: workspaces.status,
        createdBy: { id: users.id, email: users.email },
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
      })
      .from(workspaces)
      .innerJoin(users, eq(users.id, workspaces.userId))

  const get = async (id: string) => {
    const [workspace] = await select().where(eq(workspaces.id, id))
    if (!workspace) throw new HttpError(404, 'Workspace not found')
    return workspace
  }

  return {
    create: async (userId: string, name: string) => {
      if (!new RegExp(NAME_PATTERN).test(name))
        throw new HttpError(400, 'Use 1–63 lowercase letters, digits and -, not starting or ending with -')

      const created = await db.transaction(async tx => {
        const [row] = await tx
          .insert(workspaces)
          .values({ userId, name })
          .onConflictDoNothing({ target: workspaces.name })
          .returning({ id: workspaces.id })
        if (row) await mkdir(path(row.id), { recursive: true })
        return row
      })
      if (!created) throw new HttpError(409, 'A workspace already has this name')

      return get(created.id)
    },

    get,

    delete: async (id: string) => {
      await db.transaction(async tx => {
        const [row] = await tx.delete(workspaces).where(eq(workspaces.id, id)).returning({ id: workspaces.id })
        if (!row) throw new HttpError(404, 'Workspace not found')

        await mkdir(join(resolve(dir), '.deleted'), { recursive: true })
        await rename(path(id), trash(id)).catch(err => {
          if (err.code !== 'ENOENT') throw err
        })
      })

      rm(trash(id), { recursive: true, force: true }).catch(err =>
        log.error({ err, id }, 'failed to remove deleted workspace files')
      )
    },

    uploadsDir,

    extract: async (id: string, { zip, path: folder }: { zip: string; path: string }) => {
      const root = path(id)
      const target = resolve(root, folder.replace(/^\/+/, ''))
      const relativePath = relative(root, target)

      let accepted = false
      let files: number
      try {
        await get(id)
        if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
          throw new HttpError(400, 'path leads outside the workspace')
        if ((await stat(target).catch(() => null))?.isFile()) throw new HttpError(400, `${relativePath} is a file`)
        files = await checkZip(zip)
        accepted = true
      } finally {
        if (!accepted) await rm(zip, { force: true })
      }

      mkdir(target, { recursive: true })
        .then(() => extractZip(zip, target))
        .then(() => db.update(workspaces).set({ updatedAt: sql`now()` }).where(eq(workspaces.id, id)))
        .catch(err => log.error({ err, id }, 'failed to extract upload'))
        .then(() => rm(zip, { force: true }))
        .catch(err => log.error({ err, zip }, 'failed to remove upload'))

      return { path: relativePath, files }
    },

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

    list: async ({ limit, offset }: { limit: number; offset: number }) => {
      const [items, total] = await Promise.all([
        select().orderBy(desc(workspaces.createdAt), desc(workspaces.id)).limit(limit).offset(offset),
        db.$count(workspaces),
      ])
      return { items, total }
    },
  }
}
