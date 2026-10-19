import { Type } from 'typebox'

export const WorkspacesQuery = Type.Object({ page: Type.Integer({ minimum: 1, default: 1 }) })

export const WorkspaceParams = Type.Object({ id: Type.String({ format: 'uuid' }) })
