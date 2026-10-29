import { Type } from 'typebox'

import {
  ClickBody as WorkerClickBody,
  CreateBody as WorkerCreateBody,
  NavigateBody as WorkerNavigateBody,
  ReadBody as WorkerReadBody,
  RunBody as WorkerRunBody,
  ScreenshotBody as WorkerScreenshotBody,
  TypeBody as WorkerTypeBody,
} from '../../../services/chromium/routes/schema.ts'

export { NavigatedContent, PageContent, RunResult, Screenshot } from '../../../services/chromium/routes/schema.ts'

const Id = Type.String({ format: 'uuid' })
// a Date in code, an ISO string on the wire
const Timestamp = Type.Unsafe<Date>(Type.String({ format: 'date-time' }))

export const SessionParams = Type.Object({ id: Id })

export const BrowserSession = Type.Object({
  id: Id,
  workspaceId: Type.Union([Id, Type.Null()]),
  record: Type.Boolean(),
  status: Type.Union([Type.Literal('alive'), Type.Literal('closed')]),
  createdAt: Timestamp,
  lastUsedAt: Timestamp,
})

export const CreateBody = Type.Omit(WorkerCreateBody, ['userId'])

export const NavigateBody = Type.Omit(WorkerNavigateBody, ['sessionId'])

export const ReadBody = Type.Omit(WorkerReadBody, ['sessionId'])

export const ClickBody = Type.Omit(WorkerClickBody, ['sessionId'])

export const TypeBody = Type.Omit(WorkerTypeBody, ['sessionId'])

export const ScreenshotBody = Type.Omit(WorkerScreenshotBody, ['sessionId'])

export const RunBody = Type.Omit(WorkerRunBody, ['sessionId'])
