import { join } from 'node:path'

const root = join(import.meta.dirname, '..', 'docs')

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 8000,
  async fetch(request) {
    // URL parsing already resolves any ../ segments, so the path stays inside docs/
    const { pathname } = new URL(request.url)
    const file = Bun.file(join(root, pathname.endsWith('/') ? `${pathname}index.html` : pathname))
    if (!(await file.exists())) return new Response('Not found', { status: 404 })

    return new Response(file, { headers: { 'cache-control': 'no-store' } })
  },
})

console.log(`docs at ${server.url}`)
