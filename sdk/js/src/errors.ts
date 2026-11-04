const CODES: Record<number, CodeHarnessErrorCode> = {
  400: 'INVALID_REQUEST',
  401: 'AUTHENTICATION_FAILED',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'TOO_LARGE',
  429: 'RATE_LIMITED',
  502: 'UPSTREAM_FAILED',
  504: 'TIMEOUT',
}

export type CodeHarnessErrorCode =
  | 'INVALID_REQUEST'
  | 'AUTHENTICATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'TOO_LARGE'
  | 'RATE_LIMITED'
  | 'UPSTREAM_FAILED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'UNKNOWN'

// deepagents' SandboxError.isInstance checks this symbol, so the client entry needn't load deepagents
const SANDBOX_ERROR = Symbol.for('sandbox.error')

export class CodeHarnessError extends Error {
  override readonly name: string = 'CodeHarnessError'

  constructor(
    message: string,
    readonly code: CodeHarnessErrorCode,
    readonly status: number | null = null,
    cause?: Error
  ) {
    super(message, { cause })
    Object.defineProperty(this, SANDBOX_ERROR, { value: true })
  }

  static async fromResponse(response: Response): Promise<CodeHarnessError> {
    const body = (await response.json().catch(() => null)) as { message?: string; error?: string } | null
    const message = body?.message ?? body?.error ?? response.statusText

    return new CodeHarnessError(message, CODES[response.status] ?? 'UNKNOWN', response.status)
  }
}
