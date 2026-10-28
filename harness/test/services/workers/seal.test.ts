import { describe, expect, test } from 'bun:test'

import { open, seal } from '../../../src/services/workers/seal.ts'

const SECRET = 'a'.repeat(32)

describe('seal', () => {
  test('opens with the same secret', () => {
    expect(open(SECRET, seal(SECRET, { hostname: 'worker-0' }))).toEqual({ hostname: 'worker-0' })
  })

  test('uses a new nonce for every message', () => {
    expect(seal(SECRET, 1).nonce).not.toBe(seal(SECRET, 1).nonce)
  })

  test('refuses another secret', () => {
    expect(() => open('b'.repeat(32), seal(SECRET, { hostname: 'worker-0' }))).toThrow()
  })

  test('refuses a changed message', () => {
    const sealed = seal(SECRET, { hostname: 'worker-0' })
    const bytes = Buffer.from(sealed.data, 'base64')
    bytes[0]! ^= 1

    expect(() => open(SECRET, { ...sealed, data: bytes.toString('base64') })).toThrow()
  })
})
