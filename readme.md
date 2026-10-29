# Setup

Needs Bun 1.4.3, Docker and openssl.

```sh
bun install
cp harness/.env.example harness/.env
# set DATA_ENCRYPTION_KEY in harness/.env to the output of: openssl rand -hex 32
bun run ca:create          # adds WORKER_JOIN_SECRET, WORKER_CA_KEY and WORKER_CA_CERT to harness/.env
docker compose up -d postgres redis
bun run migrate:harness
DATABASE_URL=postgres://postgres:postgres@localhost:5432/app bun run user:create you@example.com
bun run dev:harness        # the server, on http://localhost:3000
```

## A worker

A worker is the same app with `APP_MODE=worker`. It registers with the server on boot and runs the sandboxes and browser sessions. Run it in another terminal, on another port:

```sh
cd harness
APP_MODE=worker WORKER_NAME=worker-0 SERVER_URL=http://localhost:3000 PORT=3001 bun src/index.ts
```

It needs Chromium (`bunx playwright-core install chromium`). With the default `SANDBOX_MODE=none`, workspace code runs unconfined on your machine; `SANDBOX_MODE=bwrap` confines it, and needs Linux with bubblewrap and a delegated cgroup v2 tree. The worker shows up on the Machines page once it reports its stats.

## Tests

```sh
bun run --filter harness test   # unit tests; the bwrap ones are skipped
bun run test:harness            # everything, inside a privileged Linux container
```
