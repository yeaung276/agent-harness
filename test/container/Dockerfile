FROM oven/bun:1.4.3-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     bubblewrap passt nftables ca-certificates openssl curl procps git iproute2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile && chown -R bun:bun /usr/src/app

COPY test/container/entrypoint.sh /usr/local/bin/container-test

ENV CONTAINER_TEST=1
ENTRYPOINT ["sh", "/usr/local/bin/container-test"]
