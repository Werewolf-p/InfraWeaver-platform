FROM onedev.rlservers.com/infraweaver-platform/base-node-22-alpine:latest AS builder
WORKDIR /app
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM onedev.rlservers.com/infraweaver-platform/base-node-22-alpine:latest
WORKDIR /app
ENV NODE_ENV=production
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
USER node
CMD ["node", "dist/index.js"]
