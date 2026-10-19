import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import { loadConfig } from '../src/config.ts'
import { users } from '../src/db/schema.ts'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD_LENGTH = 8

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

// Reads one line from the terminal without echoing it.
const askHidden = (question: string) =>
  new Promise<string>(resolve => {
    let input = ''
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n' || char === '\u0003') {
          process.stdin.off('data', onData).setRawMode(false).pause()
          process.stderr.write('\n')
          // raw mode turns Ctrl-C into input instead of a signal
          if (char === '\u0003') process.exit(130)
          return resolve(input)
        }
        input = char === '\u007f' || char === '\b' ? input.slice(0, -1) : input + char
      }
    }

    process.stderr.write(question)
    process.stdin.setRawMode(true).resume().on('data', onData)
  })

const readPassword = async () => {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).split(/\r?\n/)[0] ?? ''

  const password = await askHidden('Password: ')
  if (password !== (await askHidden('Repeat password: '))) fail("The passwords don't match.")
  return password
}

const email = process.argv[2]?.trim().toLowerCase()
if (!email) fail('Usage: bun run user:create <email>')
if (!EMAIL.test(email)) fail(`Not an email address: ${email}`)

const password = await readPassword()
if (password.length < MIN_PASSWORD_LENGTH) fail(`The password needs at least ${MIN_PASSWORD_LENGTH} characters.`)

const pool = new Pool({ connectionString: loadConfig().DATABASE_URL })

try {
  const [user] = await drizzle({ client: pool })
    .insert(users)
    .values({ email, passwordHash: await Bun.password.hash(password, 'argon2id') })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id })
  if (!user) fail(`${email} already exists.`)

  console.log(user.id)
} finally {
  await pool.end()
}
