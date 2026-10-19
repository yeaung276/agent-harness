import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import yauzl from 'yauzl'

import { HttpError } from '../http-error.ts'

const MAX_BYTES = 1024 ** 3

const isLink = (entry: yauzl.Entry) => ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000

// refuses the zip on its first bad entry, and returns how many files it holds
const walk = async (file: string, write?: (zip: yauzl.ZipFile, entry: yauzl.Entry) => Promise<void>) => {
  const zip = await new Promise<yauzl.ZipFile>((ok, fail) =>
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? fail(err) : ok(zip)))
  ).catch(() => {
    throw new HttpError(400, 'The file is not a zip')
  })

  let files = 0
  let bytes = 0

  const visit = async (entry: yauzl.Entry) => {
    const name = posix.normalize(entry.fileName)
    if (name === '..' || name.startsWith('../') || posix.isAbsolute(name))
      throw new HttpError(400, `${entry.fileName} leads outside the folder`)
    if (isLink(entry)) throw new HttpError(400, `${entry.fileName} is a link`)
    if (!entry.fileName.endsWith('/')) {
      files++
      bytes += entry.uncompressedSize
      if (bytes > MAX_BYTES) throw new HttpError(413, 'The zip extracts to more than 1 GB')
    }
    await write?.(zip, entry)
  }

  try {
    await new Promise<void>((done, fail) => {
      zip.on('entry', entry => visit(entry).then(() => zip.readEntry(), fail))
      zip.on('end', done)
      zip.on('error', fail)
      zip.readEntry()
    })
  } catch (err) {
    // file system errors are ours; anything else is a broken zip
    if (err instanceof HttpError || (err instanceof Error && 'syscall' in err)) throw err
    throw new HttpError(400, `The zip can't be read: ${(err as Error).message}`)
  } finally {
    zip.close()
  }

  return files
}

// reads only the zip's index, so it is quick however big the zip is
export const checkZip = (file: string) => walk(file)

export const extractZip = (file: string, dest: string) =>
  walk(file, async (zip, entry) => {
    const target = join(dest, entry.fileName)
    if (entry.fileName.endsWith('/')) return void (await mkdir(target, { recursive: true }))

    await mkdir(dirname(target), { recursive: true })
    const stream = await new Promise<Readable>((ok, fail) =>
      zip.openReadStream(entry, (err, stream) => (err ? fail(err) : ok(stream)))
    )
    await pipeline(stream, createWriteStream(target))
  })
