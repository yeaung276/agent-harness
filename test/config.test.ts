import { describe, expect, test } from 'bun:test'

import { loadConfig } from '../src/config.ts'

const required = {
  DATABASE_URL: 'postgres://localhost:5432/app',
  REDIS_URL: 'redis://localhost:6379',
  DATA_ENCRYPTION_KEY: '0'.repeat(64),
}

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
    expect(() => loadConfig({ ...required, DATABASE_URL: undefined })).toThrow()
  })

  test('rejects a missing or malformed DATA_ENCRYPTION_KEY', () => {
    expect(() => loadConfig({ ...required, DATA_ENCRYPTION_KEY: undefined })).toThrow()
    expect(() => loadConfig({ ...required, DATA_ENCRYPTION_KEY: 'not-hex' })).toThrow()
  })
})
