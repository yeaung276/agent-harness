import { Type } from 'typebox'

export const WorkspacesQuery = Type.Object({ page: Type.Integer({ minimum: 1, default: 1 }) })

export const WorkspaceParams = Type.Object({ id: Type.String({ format: 'uuid' }) })

export const EnvForm = Type.Object({ defaultEnv: Type.String() })

export const DefaultEnv = Type.Record(Type.String(), Type.String())

export const DefaultEnvChanges = Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))

export const TreeQuery = Type.Object({ path: Type.String({ default: '' }) })

export const ActivitiesQuery = Type.Object({ page: Type.Integer({ minimum: 1, default: 1 }) })

export const LogsQuery =Type.Object({ tail: Type.Integer({ default: 200, minimum: 1, maximum: 5000 }) })

export const FileParams = Type.Object({ id: Type.String({ format: 'uuid' }), '*': Type.String() })
