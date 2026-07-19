# syntax=docker/dockerfile:1.7
# In-cluster build Dockerfile (used by infraweaver-dispatch + BuildKit → Zot).
# CI still uses Dockerfile.prebuilt; this one builds from source inside BuildKit.
#
# Two BuildKit-on-Talos requirements baked in:
#   - RUN --mount=type=tmpfs,target=/dev/shm: BuildKit gives RUN steps only a
#     64MB /dev/shm; Next.js/webpack build workers SIGSEGV when it fills.
#   - NODE_OPTIONS max-old-space-size: headroom for the Next.js 16 build.
# The build must also be invoked with `--allow security.insecure` (Talos kernel
# + default seccomp otherwise SIGSEGVs node/npm).
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN --mount=type=tmpfs,target=/dev/shm npm ci --legacy-peer-deps
ARG CACHEBUST=1
ARG APP_VERSION=dev
# Base domain must be present at BUILD time: NEXT_PUBLIC_* is inlined into the
# client bundle by Next.js. Defaults to example.com for forks that don't override.
ARG NEXT_PUBLIC_BASE_DOMAIN=example.com
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION
ENV NEXT_PUBLIC_BASE_DOMAIN=$NEXT_PUBLIC_BASE_DOMAIN
ENV NODE_OPTIONS=--max-old-space-size=8192
COPY . .
RUN --mount=type=tmpfs,target=/dev/shm npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# git is required at runtime: external-routes-server.ts shells out to `git`,
# and the clone-infra-routes initContainer (which runs this same image) clones
# the private infra repo. Without it the container starts but route sync — and
# the initContainer — die with "git: not found" (exit 127).
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
# Run as non-root user (required by PodSecurity restricted policy)
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid 1001 nextjs
COPY --from=builder --chown=1001:1001 /app/.next/standalone ./
COPY --from=builder --chown=1001:1001 /app/.next/static ./.next/static
COPY --from=builder --chown=1001:1001 /app/public ./public
# Vendored InfraWeaver Connector plugin (see scripts/sync-wp-connector.sh) —
# read at runtime by the connector-package zip route + managed enrollment.
COPY --from=builder --chown=1001:1001 /app/vendor ./vendor
USER 1001
EXPOSE 3000
CMD ["node", "server.js"]
