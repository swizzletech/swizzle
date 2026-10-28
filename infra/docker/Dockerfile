ARG NODE_VERSION=26.12.1-alpine3.24

# ---------- shared foundation ----------
FROM node:${NODE_VERSION} AS base
RUN apk add --no-cache python3 py3-pip poppler-utils fontconfig ttf-freefont ttf-liberation font-noto wget git bash
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# npm installs pnpm's native binary at build time. Corepack would download it on first
# use, which the worker cannot do: it runs as its own user without the build's cache.
RUN npm install --global --no-audit --no-fund pnpm@12.15.0
WORKDIR /app

# Untrusted automations run FROM this image in a separate container. The agent
# CLIs are deliberately absent from the control-plane worker image.
FROM node:26.12.1-trixie-slim AS runner-base
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl fontconfig fonts-dejavu-core git poppler-utils python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global --no-audit --no-fund @anthropic-ai/claude-code@2.1.309 @openai/codex@0.163.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends proxychains4 \
  && rm -rf /var/lib/apt/lists/*
COPY infra/docker/runner-entrypoint.sh /usr/local/bin/swizzle-entrypoint
ENV HOME=/home/swizzle
RUN mkdir -p /home/swizzle /run/swizzle \
  && chown -R 65532:65532 /home/swizzle /run/swizzle \
  && chmod 0755 /usr/local/bin/swizzle-entrypoint
# What runs can call, recorded after the last install; the worker image copies it (runner-tools.mjs).
RUN --mount=type=bind,source=infra/docker/runner-tools.mjs,target=/tmp/runner-tools.mjs \
  mkdir -p /etc/swizzle && node /tmp/runner-tools.mjs > /etc/swizzle/runner-tools.json
CMD ["true"]

# Fetch every dependency straight from the lockfile — `pnpm fetch` ignores
# package manifests, so there is NO per-package COPY list to keep in sync (a
# forgotten entry used to silently drop a workspace's deps), and this layer only
# rebuilds when the lockfile changes. New workspace packages need no edit here.
FROM base AS deps
ARG TARGETARCH
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-${TARGETARCH},target=/pnpm/store \
    pnpm fetch

# Build the whole monorepo once; reused across all service images. The install
# is offline against the pre-fetched store, so it needs no network.
FROM deps AS build
ARG TARGETARCH
ARG VITE_API_BASE_URL=http://localhost:3000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
COPY . .
RUN --mount=type=cache,id=pnpm-${TARGETARCH},target=/pnpm/store \
    pnpm install --frozen-lockfile --offline
# Source upgrades share small hosts with the running stack. Compile one workspace at a time.
RUN pnpm exec turbo run build --concurrency=1

# Extract a self-contained prod package for a single backend workspace.
FROM build AS deploy-service
ARG TARGETARCH
ARG WORKSPACE
# pnpm deploy copies workspace dependencies into /out only when they are injected. Inject them
# for this command alone: workspace-wide injection turns the host's symlinked workspace
# packages into install-time copies that go stale after a rebuild.
RUN --mount=type=cache,id=pnpm-${TARGETARCH},target=/pnpm/store \
    pnpm --config.inject-workspace-packages=true --filter "$WORKSPACE" deploy --prod /out

# ---------- node service runtime ----------
# The API and scheduler do not package automation dependencies or probe
# automation runtimes. They only need the built Node service package.
FROM node:${NODE_VERSION} AS service
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S -g 10001 swizzle \
  && adduser -S -D -H -u 10001 -G swizzle swizzle \
  && mkdir -p /data/artifacts \
  && chown -R swizzle:swizzle /app /data
COPY --chown=swizzle:swizzle --from=deploy-service /out ./
USER 10001:10001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${HEALTHCHECK_PORT:-19820}/health" >/dev/null 2>&1 || exit 1
# The tracing preload starts OpenTelemetry before main.js loads the modules it instruments.
CMD ["node", "--import", "./dist/tracing.js", "dist/main.js"]

# ---------- operator CLI with the PostgreSQL client ----------
# The compose service `backup` runs it once per `just backup` or `just restore`.
FROM service AS cli
USER root
RUN apk add --no-cache postgresql18-client \
  && mkdir -p /backup \
  && chown swizzle:swizzle /backup \
  && chmod 0700 /backup
USER 10001:10001
HEALTHCHECK NONE
ENTRYPOINT ["node", "dist/bin.js"]
CMD ["--help"]

# ---------- automation-capable service runtime ----------
FROM base AS service-automation
USER root
RUN apk add --no-cache docker-cli
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S -g 10001 swizzle \
  && adduser -S -D -H -u 10001 -G swizzle swizzle \
  && mkdir -p /data/artifacts /data/dep-cache /data/worker /home/swizzle \
  && chmod 0700 /data/worker \
  && chown -R swizzle:swizzle /app /data /home/swizzle
COPY --chown=swizzle:swizzle --from=deploy-service /out ./
# The binaries deployed runs find in the runner image, which this worker reports (readRunnerTools).
COPY --from=runner-base /etc/swizzle/runner-tools.json /etc/swizzle/runner-tools.json
USER 10001:10001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${HEALTHCHECK_PORT:-19820}/health" >/dev/null 2>&1 || exit 1
# The tracing preload starts OpenTelemetry before main.js loads the modules it instruments.
CMD ["node", "--import", "./dist/tracing.js", "dist/main.js"]

# ---------- Docker broker ----------
# The worker's only route to the Docker socket (apps/docker-broker). It runs as root, which owns
# the socket, with every capability dropped in compose.yml, and depends on nothing beyond Node.
FROM node:${NODE_VERSION} AS docker-broker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/apps/docker-broker/package.json ./
COPY --from=build /app/apps/docker-broker/dist ./dist
CMD ["node", "dist/main.js"]

# ---------- web static runtime ----------
FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24 AS web
RUN printf '%s\n' \
    'server {' \
    '  listen 4173;' \
    '  root /usr/share/nginx/html;' \
    '  index index.html;' \
    '  location / { try_files $uri $uri/ /index.html; }' \
    '}' > /etc/nginx/conf.d/default.conf
COPY --chown=101:101 --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 4173

# ---------- outbound-only proxy for untrusted automation containers ----------
FROM alpine:3.24.3 AS runner-egress-proxy
RUN apk add --no-cache squid \
  && mkdir -p /var/cache/squid /var/log/squid /var/run/squid \
  && chown -R squid:squid /var/cache/squid /var/log/squid /var/run/squid
COPY infra/docker/squid.conf /etc/squid/squid.conf
USER squid:squid
EXPOSE 3128
CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]

# The control proxy shares the runner's deny rules, with endpoint exceptions generated only here.
FROM runner-egress-proxy AS control-egress-proxy
USER root
RUN apk add --no-cache nodejs
COPY infra/docker/control-egress.mjs /usr/local/bin/control-egress.mjs
USER squid:squid
CMD ["sh", "-ec", "node /usr/local/bin/control-egress.mjs > /tmp/control-squid.conf; exec squid -N -f /tmp/control-squid.conf"]

# ---------- edge proxy ----------
# The Caddyfile is part of the image, so `just stack` rebuilds it and recreates Caddy when the file
# changes; a bind mount would keep serving the old policy until a manual restart.
FROM caddy:2.11.7-alpine AS caddy
COPY infra/docker/Caddyfile /etc/caddy/Caddyfile
