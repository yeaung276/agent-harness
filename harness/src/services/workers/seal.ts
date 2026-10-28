import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const NONCE_BYTES = 12
const TAG_BYTES = 16

export type Sealed = { nonce: string; data: string }

const keyOf = (secret: string) => Buffer.from(hkdfSync('sha256', secret, '', 'worker registration', 32))

export const seal = (secret: string, value: unknown): Sealed => {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', keyOf(secret), nonce)
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()])

  return { nonce: nonce.toString('base64'), data: data.toString('base64') }
}

export const open = (secret: string, { nonce, data }: Sealed): unknown => {
  const bytes = Buffer.from(data, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), Buffer.from(nonce, 'base64'))
  decipher.setAuthTag(bytes.subarray(-TAG_BYTES))

  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -TAG_BYTES)), decipher.final()]).toString())
}
