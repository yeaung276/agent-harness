FROM oven/bun:1.4.3-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     bubblewrap passt nftables ca-certificates openssl curl procps git iproute2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile && chown -R bun:bun /usr/src/app

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN bunx playwright-core install --with-deps chromium

COPY test/container/entrypoint.sh /usr/local/bin/container-test

ENV CONTAINER_TEST=1
ENV DATABASE_URL=postgres://localhost:5432/test \
    REDIS_URL=redis://localhost:6379 \
    DATA_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
ENTRYPOINT ["sh", "/usr/local/bin/container-test"]
