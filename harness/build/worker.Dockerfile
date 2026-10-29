FROM oven/bun:1.4.3-slim AS base

WORKDIR /usr/src/app


FROM base AS build

COPY package.json bun.lock ./
COPY harness/package.json harness/
RUN bun install --frozen-lockfile --ignore-scripts

COPY harness/src harness/src
# bundles the server into harness/dist, with views, public and playwright-core (runner.ts mounts it into the sandbox)
RUN bun run build:harness


FROM base AS runner

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    APP_MODE=worker \
    SANDBOX_MODE=bwrap \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# the sandbox: bwrap, pasta, nft, and util-linux for unshare, nsenter and setpriv;
# the rest is the workload's toolset, mounted read-only into every sandbox from /usr
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     bubblewrap passt nftables util-linux bash dumb-init \
     openssl ca-certificates git openssh-client \
     curl wget netcat-openbsd iproute2 \
     build-essential python3 python3-pip pkg-config nodejs npm \
     unzip zip xz-utils bzip2 procps psmisc lsof \
     jq ripgrep less file tree postgresql-client sqlite3 tzdata \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/src/app/harness/dist harness/dist

# the worker launches chromium at boot, from /opt, which every sandbox mounts
RUN bun harness/dist/node_modules/playwright-core/cli.js install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /workspaces \
  && chown bun:bun /workspaces

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
# starts as root to delegate the cgroup tree to bun, then runs as bun;
# run from the repo root: the sandbox hides process.cwd(), so this keeps all of /usr/src/app out of it
CMD ["sh", "-c", "cg=/sys/fs/cgroup && chown bun:bun $cg $cg/cgroup.procs $cg/cgroup.subtree_control $cg/cgroup.threads && exec setpriv --reuid bun --regid bun --init-groups env HOME=/home/bun bun harness/dist/index.js"]
