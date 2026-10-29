FROM oven/bun:1.4.3-slim AS base

WORKDIR /usr/src/app


FROM base AS build

COPY package.json bun.lock ./
COPY harness/package.json harness/
RUN bun install --frozen-lockfile --ignore-scripts

COPY harness/src harness/src
# bundles the server into harness/dist, with views, public and playwright-core
RUN bun run build:harness


FROM base AS runner

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/src/app/harness/dist harness/dist

USER bun

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["bun", "harness/dist/index.js"]
