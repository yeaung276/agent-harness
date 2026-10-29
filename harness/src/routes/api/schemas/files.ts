import { Type } from 'typebox'

export const TreeQuery = Type.Object({ path: Type.String({ default: '' }) })

export const Tree = Type.Object({ paths: Type.Array(Type.String()) })

export const FileParams = Type.Object({ id: Type.String({ format: 'uuid' }), '*': Type.String() })

export const ReadFileQuery = Type.Object({
  offset: Type.Integer({ minimum: 0, default: 0 }),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  raw: Type.Boolean({ default: false }),
})

export const FileContent = Type.Object({ content: Type.String(), totalLines: Type.Integer() })

export const RawFile = Type.Unsafe<ReadableStream>({ type: 'string', format: 'binary' })

export const WriteFileBody = Type.Object({ content: Type.String() })

export const EditFileBody = Type.Object({ search: Type.String({ minLength: 1 }), replace: Type.String() })
