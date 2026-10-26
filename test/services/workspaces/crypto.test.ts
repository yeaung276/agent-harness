import { describe, expect, test } from 'bun:test'

import { decrypt, encrypt } from '../../../src/services/workspaces/crypto.ts'

const key = '0'.repeat(64)

describe('encrypt and decrypt', () => {
  test('a value decrypts back to itself', () => {
    expect(decrypt(key, encrypt(key, 'secret-value'))).toBe('secret-value')
  })

  test('the same value encrypts differently each time', () => {
    expect(encrypt(key, 'secret-value')).not.toBe(encrypt(key, 'secret-value'))
  })

  test('another key cannot decrypt it', () => {
    expect(() => decrypt('1'.repeat(64), encrypt(key, 'secret-value'))).toThrow()
  })
})
