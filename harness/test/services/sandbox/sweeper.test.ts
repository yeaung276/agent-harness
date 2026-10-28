import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'

import type { createSandboxManager } from '../../../src/services/sandbox/manager.ts'
import { sweeper } from '../../../src/services/sandbox/sweeper.ts'

const MINUTE = 60 * 1000

let sweeps: number
let failing: boolean
let sweep: ReturnType<typeof sweeper>

beforeEach(() => {
  jest.useFakeTimers()

  sweeps = 0
  failing = false
  const manager = {
    stopIdle: async () => {
      sweeps++
      if (failing) throw new Error('database down')
    },
  } as unknown as ReturnType<typeof createSandboxManager>

  sweep = sweeper(manager)
})

afterEach(() => {
  sweep.stop()
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe('sweeper', () => {
  test('stops idle launches once a minute', () => {
    sweep.start()

    jest.advanceTimersByTime(MINUTE - 1)
    expect(sweeps).toBe(0)

    jest.advanceTimersByTime(1)
    expect(sweeps).toBe(1)

    jest.advanceTimersByTime(2 * MINUTE)
    expect(sweeps).toBe(3)
  })

  test('keeps sweeping after a sweep fails', async () => {
    failing = true
    sweep.start()

    jest.advanceTimersByTime(MINUTE)
    await Promise.resolve()
    jest.advanceTimersByTime(MINUTE)

    expect(sweeps).toBe(2)
  })

  test('stops sweeping once stopped', () => {
    sweep.start()
    sweep.stop()

    jest.advanceTimersByTime(3 * MINUTE)

    expect(sweeps).toBe(0)
  })

  test('never keeps the process alive', () => {
    const setInterval = jest.spyOn(globalThis, 'setInterval')

    sweep.start()

    expect((setInterval.mock.results[0]!.value as NodeJS.Timeout).hasRef()).toBe(false)
  })
})
