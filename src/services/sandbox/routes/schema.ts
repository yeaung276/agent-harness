import { Type } from 'typebox'

const WorkspaceId = Type.String({ format: 'uuid' })
const Command = Type.String({ minLength: 1 })
const Env = Type.Record(Type.String(), Type.String())

export const LaunchBody = Type.Object({
  workspaceId: WorkspaceId,
  command: Command,
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  env: Type.Optional(Env),
  network: Type.Optional(
    Type.Object({ allow: Type.Optional(Type.Array(Type.String())), deny: Type.Optional(Type.Array(Type.String())) })
  ),
})

export const ExecBody = Type.Object({
  workspaceId: WorkspaceId,
  command: Command,
  timeoutMs: Type.Integer({ default: 120_000, minimum: 1, maximum: 240_000 }),
  env: Type.Optional(Env),
})

export const ExecResult = Type.Object({
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  output: Type.String(),
  timedOut: Type.Boolean(),
})

export const StopBody = Type.Object({ workspaceId: WorkspaceId })

export const LogsBody = Type.Object({
  workspaceId: WorkspaceId,
  tail: Type.Integer({ default: 200, minimum: 1, maximum: 5000 }),
})

export const Logs = Type.Object({ lines: Type.Array(Type.String()) })
