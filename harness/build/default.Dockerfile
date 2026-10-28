FROM oven/bun:1.4.3-slim AS base

WORKDIR /usr/src/app


FROM base AS build

COPY package.json bun.lock ./
COPY harness/package.json harness/
RUN bun install --frozen-lockfile

COPY harness/src harness/src
# bundles the server into harness/dist, with views, public and playwright-core (runner.ts mounts it into the sandbox)
RUN bun run build:harness


FROM base AS runner

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     bubblewrap passt nftables dumb-init \
     openssl ca-certificates git openssh-client \
     curl wget netcat-openbsd iproute2 \
     build-essential python3 pkg-config \
     unzip zip xz-utils bzip2 procps psmisc lsof \
     jq ripgrep less file tree postgresql-client sqlite3 tzdata \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/src/app/harness/dist harness/dist

RUN mkdir -p /workspaces \
  && chown bun:bun /workspaces

USER bun

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
# run from the repo root: the sandbox hides process.cwd(), so this keeps all of /usr/src/app out of it
CMD ["bun", "harness/dist/index.js"]
