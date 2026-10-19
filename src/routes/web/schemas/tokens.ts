import { Type } from 'typebox'

export const CreateTokenBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100, pattern: '\\S' }),
  expiresIn: Type.Union([Type.Literal('30'), Type.Literal('90'), Type.Literal('365'), Type.Literal('never')]),
})

export const TokensQuery = Type.Object({ page: Type.Integer({ minimum: 1, default: 1 }) })

export const TokenParams = Type.Object({ id: Type.String({ format: 'uuid' }) })
