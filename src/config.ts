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
  HOST: Type.String({ default: '127.0.0.1' }),
  PORT: Type.Integer({ minimum: 0, maximum: 65535, default: 3000 }),
  DATABASE_URL: Type.String({ minLength: 1 }),
  REDIS_URL: Type.String({ minLength: 1 }),
})

export type Config = Static<typeof ConfigSchema>

export const loadConfig = (env: Record<string, string | undefined> = process.env): Config => {
  const values = Value.Default(ConfigSchema, { ...env })
  return Value.Parse(ConfigSchema, Value.Clean(ConfigSchema, Value.Convert(ConfigSchema, values)))
}
