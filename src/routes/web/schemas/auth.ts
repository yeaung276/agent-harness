import { Type } from 'typebox'

export const LoginBody = Type.Object({ email: Type.String(), password: Type.String() })
