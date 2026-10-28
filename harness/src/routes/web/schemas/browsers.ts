import { Type } from 'typebox'

export const BrowsersQuery = Type.Object({ page: Type.Integer({ minimum: 1, default: 1 }) })
