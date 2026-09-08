# syntax=docker/dockerfile:1

# ---- Build stage: compile TypeScript to dist/ ----
FROM node:20-slim AS builder

# better-sqlite3 is a native addon and needs a toolchain to compile during `npm ci`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies now, in the stage that already has the compiled
# native addon, so the runtime stage doesn't need a compiler toolchain at all.
RUN npm prune --omit=dev

# ---- Runtime stage: run the compiled output on a slim Node 20 base ----
FROM node:20-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# REST/WS API (HTTP_PORT) and the zwave-js-server WebSocket protocol (ZWAVE_SERVER_PORT).
EXPOSE 3000 3001

CMD ["node", "dist/index.js"]
