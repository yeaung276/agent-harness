import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import fastifyMultipart from '@fastify/multipart'
import type { FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

import { HttpError } from '../services/http-error.ts'

const MAX_FILE_BYTES = 100 * 1024 * 1024

export const multipart = fp(
  async app => {
    await app.register(fastifyMultipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1 } })
  },
  { name: 'multipart' }
)

// the form's text fields, and its file written into folder as it arrives; the caller removes the file
export const readForm = async (request: FastifyRequest, folder: string) => {
  const fields: Record<string, string> = {}
  let file: string | null = null

  try {
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        fields[part.fieldname] = String(part.value)
      } else if (!part.filename) {
        // a browser sends an empty file part when no file was chosen
        part.file.resume()
      } else {
        file = join(folder, `${randomUUID()}.zip`)
        await mkdir(folder, { recursive: true })
        await pipeline(part.file, createWriteStream(file))
        if (part.file.truncated) throw new HttpError(413, 'The upload is over 100 MB')
      }
    }
  } catch (err) {
    if (file) await rm(file, { force: true })
    if (err instanceof HttpError) throw err
    const code = (err as { code?: string }).code
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw new HttpError(413, 'The upload is over 100 MB')
    if (code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') throw new HttpError(400, 'Send the form as multipart/form-data')
    throw err
  }

  return { fields, file }
}
