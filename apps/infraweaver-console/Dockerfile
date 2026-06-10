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
COPY --from=builder --chown=1001:1001 /app/.next/standalone ./
COPY --from=builder --chown=1001:1001 /app/.next/static ./.next/static
COPY --from=builder --chown=1001:1001 /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
