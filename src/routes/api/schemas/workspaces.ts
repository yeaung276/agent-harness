import { Type } from 'typebox'

import { NAME_PATTERN } from '../../../services/workspaces/index.ts'

// a Date in code, an ISO string on the wire
const Timestamp = Type.Unsafe<Date>(Type.String({ format: 'date-time' }))

export const Workspace = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  status: Type.Enum(['running', 'stopped']),
  createdBy: Type.Object({ id: Type.String({ format: 'uuid' }), email: Type.String() }),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

export const CreateWorkspaceBody = Type.Object({ name: Type.String({ pattern: NAME_PATTERN }) })

export const WorkspaceParams = Type.Object({ id: Type.String({ format: 'uuid' }) })

export const UploadAccepted = Type.Object({ path: Type.String(), files: Type.Integer() })
