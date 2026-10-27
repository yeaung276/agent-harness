import { Type } from 'typebox'

const Id = Type.String({ format: 'uuid' })
const Timestamp = Type.Unsafe<Date>(Type.String({ format: 'date-time' }))

const WaitFor = Type.Object({
  selector: Type.Optional(Type.String({ minLength: 1 })),
  text: Type.Optional(Type.String({ minLength: 1 })),
  timeoutMs: Type.Integer({ default: 10_000, minimum: 1, maximum: 60_000 }),
})

const PageRef = Type.Object({
  ref: Type.Integer(),
  tag: Type.String(),
  role: Type.Union([Type.String(), Type.Null()]),
  name: Type.String(),
  value: Type.String(),
  placeholder: Type.String(),
  href: Type.String(),
})

export const PageContent = Type.Object({
  title: Type.String(),
  url: Type.String(),
  text: Type.String(),
  refs: Type.Array(PageRef),
})

export const NavigatedContent = Type.Object({
  ...PageContent.properties,
  status: Type.Union([Type.Integer(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
})

export const Session = Type.Object({
  id: Id,
  workspaceId: Type.Union([Id, Type.Null()]),
  record: Type.Boolean(),
  status: Type.Union([Type.Literal('alive'), Type.Literal('closed')]),
  userId: Id,
  createdAt: Timestamp,
  lastUsedAt: Timestamp,
})

export const CreateBody = Type.Object({
  userId: Id,
  workspaceId: Type.Optional(Id),
  record: Type.Boolean({ default: false }),
})

export const NavigateBody = Type.Object({
  sessionId: Id,
  url: Type.String({ minLength: 1, maxLength: 4000 }),
  until: Type.Optional(WaitFor),
})

export const ReadBody = Type.Object({
  sessionId: Id,
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  waitFor: Type.Optional(WaitFor),
})

export const ClickBody = Type.Object({
  sessionId: Id,
  ref: Type.Integer({ minimum: 1 }),
  waitFor: Type.Optional(WaitFor),
})

export const TypeBody = Type.Object({
  sessionId: Id,
  ref: Type.Integer({ minimum: 1 }),
  text: Type.String({ maxLength: 10_000 }),
  submit: Type.Boolean({ default: false }),
  waitFor: Type.Optional(WaitFor),
})

export const ScreenshotBody = Type.Object({
  sessionId: Id,
  fullPage: Type.Boolean({ default: false }),
  waitFor: Type.Optional(WaitFor),
})

export const Screenshot = Type.Object({ path: Type.String() })

export const RunBody = Type.Object({
  sessionId: Id,
  code: Type.String({ minLength: 1, maxLength: 100_000 }),
  timeoutMs: Type.Integer({ default: 60_000, minimum: 1000, maximum: 120_000 }),
})

export const RunResult = Type.Object({
  result: Type.Unknown(),
  error: Type.Union([Type.String(), Type.Null()]),
  durationMs: Type.Integer(),
})

export const CloseBody = Type.Object({ sessionId: Id })
