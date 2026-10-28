import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ENV_FILE = join(import.meta.dirname, '..', 'harness', '.env')
const VALID_DAYS = 3650

const env = (await Bun.file(ENV_FILE).exists()) ? await Bun.file(ENV_FILE).text() : ''
const has = (name: string) => new RegExp(`^${name}=`, 'm').test(env)
const line = (name: string, value: string) => `${name}="${value.trim().replaceAll('\n', '\\n')}"`

const generateCa = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worker-ca-'))
  try {
    const key = join(dir, 'ca.key')
    const cert = join(dir, 'ca.crt')
    await Bun.$`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ${key} -out ${cert} -subj /CN=worker-ca -days ${VALID_DAYS}`.quiet()
    return [line('WORKER_CA_KEY', await Bun.file(key).text()), line('WORKER_CA_CERT', await Bun.file(cert).text())]
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const added = [
  ...(has('WORKER_JOIN_SECRET') ? [] : [line('WORKER_JOIN_SECRET', randomBytes(32).toString('hex'))]),
  ...(has('WORKER_CA_KEY') || has('WORKER_CA_CERT') ? [] : await generateCa()),
]

if (added.length === 0) {
  console.log(`${ENV_FILE} already has WORKER_JOIN_SECRET and a worker CA; remove them first to make new ones.`)
} else {
  const separator = env === '' || env.endsWith('\n') ? '' : '\n'
  await Bun.write(ENV_FILE, `${env}${separator}${added.join('\n')}\n`)
  console.log(`Wrote ${added.map(entry => entry.slice(0, entry.indexOf('='))).join(', ')} to ${ENV_FILE}`)
}
