import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ENV_FILE = join(import.meta.dirname, '..', 'harness', '.env')
const VALID_DAYS = 3650

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const env = (await Bun.file(ENV_FILE).exists()) ? await Bun.file(ENV_FILE).text() : ''
if (/^WORKER_CA_(KEY|CERT)=/m.test(env)) fail(`${ENV_FILE} already has a worker CA; remove it first to make a new one.`)

const dir = await mkdtemp(join(tmpdir(), 'worker-ca-'))
try {
  const key = join(dir, 'ca.key')
  const cert = join(dir, 'ca.crt')
  await Bun.$`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ${key} -out ${cert} -subj /CN=worker-ca -days ${VALID_DAYS}`.quiet()

  const line = (name: string, pem: string) => `${name}="${pem.trim().replaceAll('\n', '\\n')}"`
  const separator = env === '' || env.endsWith('\n') ? '' : '\n'
  await Bun.write(
    ENV_FILE,
    `${env}${separator}${line('WORKER_CA_KEY', await Bun.file(key).text())}\n${line('WORKER_CA_CERT', await Bun.file(cert).text())}\n`
  )
  console.log(`Wrote WORKER_CA_KEY and WORKER_CA_CERT to ${ENV_FILE}`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
