FROM oven/bun:1.4.3-slim AS base

WORKDIR /usr/src/app


FROM base AS build

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src src
RUN bun run build


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

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /usr/src/app/src src
COPY scripts scripts
COPY drizzle drizzle

RUN mkdir -p /workspaces \
  && chown bun:bun /workspaces

USER bun

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["bun", "src/index.ts"]
