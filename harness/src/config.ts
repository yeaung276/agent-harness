import { type Static, Type } from 'typebox'
import { Value } from 'typebox/value'

export const ConfigSchema = Type.Object({
  NODE_ENV: Type.Union([Type.Literal('development'), Type.Literal('production'), Type.Literal('test')], {
    default: 'development',
  }),
  LOG_LEVEL: Type.Union(
    [
      Type.Literal('fatal'),
      Type.Literal('error'),
      Type.Literal('warn'),
      Type.Literal('info'),
      Type.Literal('debug'),
      Type.Literal('trace'),
      Type.Literal('silent'),
    ],
    { default: 'info' }
  ),
  APP_MODE: Type.Union([Type.Literal('server'), Type.Literal('worker')], { default: 'server' }),
  HOST: Type.String({ default: '127.0.0.1' }),
  PORT: Type.Integer({ minimum: 0, maximum: 65535, default: 3000 }),
  DATABASE_URL: Type.String({ minLength: 1 }),
  REDIS_URL: Type.String({ minLength: 1 }),
  WORKSPACES_DIR: Type.String({ minLength: 1, default: '/workspaces' }),

  
  SANDBOX_MODE: Type.Union([Type.Literal('bwrap'), Type.Literal('none')], { default: 'none' }),
  SANDBOX_DEPS_ROOT: Type.String({ default: '/tmp/workspace-deps' }),
  SANDBOX_IDLE_MS: Type.Number({ default: 15 * 60 * 1000 }),
  SANDBOX_MEMORY_MAX_MB: Type.Number({ default: 2048 }),
  SANDBOX_CPU_MAX: Type.Number({ default: 2 }),
  SANDBOX_PIDS_MAX: Type.Number({ default: 512 }),
  SANDBOX_PORT_MIN: Type.Number({ default: 4100 }),
  SANDBOX_PORT_MAX: Type.Number({ default: 4149 }),
  
  BROWSER_IDLE_MS: Type.Number({ default: 5 * 60 * 1000 }),
  
  DATA_ENCRYPTION_KEY: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  WORKER_JOIN_SECRET: Type.Optional(Type.String({ minLength: 32 })),
  // the server only; PEM, EC P-256
  WORKER_CA_KEY: Type.Optional(Type.String({ minLength: 1 })),
  WORKER_CA_CERT: Type.Optional(Type.String({ minLength: 1 })),
})

export type Config = Static<typeof ConfigSchema>

export const loadConfig = (env: Record<string, string | undefined> = process.env): Config => {
  const values = Value.Default(ConfigSchema, { ...env })
  return Value.Parse(ConfigSchema, Value.Clean(ConfigSchema, Value.Convert(ConfigSchema, values)))
}
