import { Type } from 'typebox'

export const BrowsersQuery = Type.Object({ page: Type.Integer({ minimum: 1, default: 1 }) })

export const BrowserParams = Type.Object({ id: Type.String({ format: 'uuid' }) })

export const ActivitiesQuery = Type.Object({ page: Type.Integer({ minimum: 1, default: 1 }) })
