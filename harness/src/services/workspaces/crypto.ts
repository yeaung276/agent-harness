import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export const encrypt = (key: string, plaintext: string) => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('hex')).join(':')
}

export const decrypt = (key: string, stored: string) => {
  const [iv, tag, ciphertext] = stored.split(':').map(part => Buffer.from(part, 'hex'))
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv!)
  decipher.setAuthTag(tag!)
  return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString('utf8')
}
