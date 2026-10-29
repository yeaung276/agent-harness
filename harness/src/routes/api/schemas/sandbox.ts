import { Type } from 'typebox'

import {
  ExecBody as WorkerExecBody,
  LaunchBody as WorkerLaunchBody,
  LogsBody as WorkerLogsBody,
} from '../../../services/sandbox/routes/schema.ts'

export { ExecResult, Logs } from '../../../services/sandbox/routes/schema.ts'

export const LaunchBody = Type.Omit(WorkerLaunchBody, ['workspaceId'])

export const Launched = Type.Object({ url: Type.String() })

export const ExecBody = Type.Omit(WorkerExecBody, ['workspaceId'])

export const LogsQuery = Type.Omit(WorkerLogsBody, ['workspaceId'])
