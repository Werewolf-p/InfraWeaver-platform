FROM onedev.rlservers.com/infraweaver-platform/base-node-20-slim:latest AS builder
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

FROM onedev.rlservers.com/infraweaver-platform/base-node-20-slim:latest AS runner
WORKDIR /app
ENV NODE_ENV=production

# Note: PodSecurity restricted policy requires non-root, but runner environment
# has issues with user creation. Using default node user (UID 1000) which is acceptable.
# The deployment can enforce securityContext if needed.

COPY --from=builder --chown=1001:1001 /app/.next/standalone ./
COPY --from=builder --chown=1001:1001 /app/.next/static ./.next/static
COPY --from=builder --chown=1001:1001 /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
