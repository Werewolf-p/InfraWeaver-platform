FROM public.ecr.aws/docker/library/node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps
# CACHEBUST ensures COPY . . and npm run build never use stale cache
# (BuildKit can fail to invalidate cache for dirs with special chars like '(dashboard)')
ARG CACHEBUST=1
# APP_VERSION is the git short SHA injected by CI for the version indicator in the UI
ARG APP_VERSION=dev
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION
COPY . .
RUN npm run build

FROM public.ecr.aws/docker/library/node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Run as non-root user (required by PodSecurity restricted policy)
# Use separate RUN commands and apk add to avoid segfault in buildx
RUN apk add --no-cache shadow && \
    groupadd --system --gid 1001 nodejs || true && \
    useradd --system --uid 1001 --gid 1001 nextjs || true
USER 1001

COPY --from=builder --chown=1001:1001 /app/.next/standalone ./
COPY --from=builder --chown=1001:1001 /app/.next/static ./.next/static
COPY --from=builder --chown=1001:1001 /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
