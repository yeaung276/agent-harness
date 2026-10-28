import { describe, expect, test } from 'bun:test'

import { portPool } from '../../../src/services/sandbox/port-pool.ts'

describe('port pool', () => {
  test('gives every workspace on the pod its own port inside the range', () => {
    const pool = portPool(4100, 4104)

    const ports = Array.from({ length: 5 }, () => pool.take())

    expect(new Set(ports).size).toBe(5)
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(4100)
      expect(port).toBeLessThanOrEqual(4104)
    }
  })

  test('refuses once the range is used up, rather than sharing a port', () => {
    const pool = portPool(4100, 4101)

    pool.take()
    pool.take()

    expect(pool.take()).toBeNull()
  })

  test("hands a stopped workspace's port to the next workspace", () => {
    const pool = portPool(4100, 4101)

    const first = pool.take() as number
    pool.take()
    pool.release(first)

    expect(pool.take()).toBe(first)
    expect(pool.take()).toBeNull()
  })
})
