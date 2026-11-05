import { Type } from 'typebox'

import { NAME_PATTERN } from '../../../services/workspaces/index.ts'

// a Date in code, an ISO string on the wire
const Timestamp = Type.Unsafe<Date>(Type.String({ format: 'date-time' }))

const Network = Type.Object({
  allow: Type.Optional(Type.Array(Type.String())),
  deny: Type.Optional(Type.Array(Type.String())),
})

export const Workspace = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  status: Type.Enum(['starting', 'running', 'stopped']),
  defaultEnvKeys: Type.Array(Type.String()),
  network: Network,
  createdBy: Type.Object({ id: Type.String({ format: 'uuid' }), email: Type.String() }),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

export const CreateWorkspaceBody = Type.Object({
  name: Type.String({ pattern: NAME_PATTERN }),
  defaultEnv: Type.Optional(Type.Record(Type.String(), Type.String())),
  network: Type.Optional(Network),
})

export const UpdateWorkspaceBody = Type.Object({
  defaultEnv: Type.Optional(Type.Record(Type.String(), Type.Unsafe<string | null>({ type: ['string', 'null'] }))),
  network: Type.Optional(Network),
})

export const WorkspaceParams = Type.Object({ id: Type.String({ format: 'uuid' }) })

export const UploadAccepted = Type.Object({ path: Type.String(), files: Type.Integer() })
