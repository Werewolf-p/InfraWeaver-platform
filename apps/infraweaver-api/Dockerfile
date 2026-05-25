FROM node:22-alpine AS builder
WORKDIR /app
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
COPY package*.json ./
RUN npm ci
COPY tsconfig.json esbuild.config.mjs ./
COPY src/ ./src/
# Bundle all deps except @kubernetes/client-node into a single ESM file.
RUN npm run bundle

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
# Install only @kubernetes/client-node and its transitive deps (~60 MB).
# Everything else (hono, zod, ws, simple-git, …) is inlined in dist/index.mjs.
COPY package.production.json ./package.json
RUN npm install --omit=dev
COPY --from=builder /app/dist/index.cjs ./dist/
USER node
EXPOSE 3001
CMD ["node", "dist/index.cjs"]
