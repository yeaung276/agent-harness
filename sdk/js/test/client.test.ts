import { expect, test } from 'bun:test'
import { dirname, join } from 'node:path'

const transpiler = new Bun.Transpiler({ loader: 'ts' })

// the client entry is for callers without deepagents, langchain or zod installed
test('the client entry imports nothing outside the package', async () => {
  const seen = new Set<string>()
  const external = new Set<string>()
  const visit = async (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const { path, kind } of transpiler.scanImports(await Bun.file(file).text())) {
      if (kind !== 'import-statement') continue
      if (path.startsWith('.')) await visit(join(dirname(file), path.replace(/\.js$/, '.ts')))
      else external.add(path)
    }
  }
  await visit(join(import.meta.dir, '../src/core/index.ts'))

  expect([...external]).toEqual([])
})
