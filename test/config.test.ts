import { describe, expect, test } from 'bun:test'

import { loadConfig } from '../src/config.ts'

const required = { DATABASE_URL: 'postgres://localhost:5432/app', REDIS_URL: 'redis://localhost:6379' }

describe('loadConfig', () => {
  test('fills defaults, converts numbers and drops unknown variables', () => {
    expect(loadConfig({ ...required, PORT: '8080', UNRELATED: 'x' })).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      HOST: '127.0.0.1',
      PORT: 8080,
      WORKSPACES_DIR: '/workspaces',
      ...required,
    })
  })

  test('rejects a missing DATABASE_URL', () => {
    expect(() => loadConfig({ REDIS_URL: required.REDIS_URL })).toThrow()
  })
})
