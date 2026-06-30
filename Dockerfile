# syntax=docker/dockerfile:1
#
# Production image for the Store Ops MCP server.
#
# Multi-stage build: a "build" stage compiles TypeScript with the full
# dependency set, then a lean "runtime" stage carries only production
# dependencies and the compiled output. The server speaks MCP over stdio, runs
# as an unprivileged user, and writes its audit/debug logs to a mounted volume
# so all data stays inside Korral's private cloud (see DEPLOYMENT.md).

############################
# Stage 1 — build
############################
FROM node:20.20.1-alpine AS build
WORKDIR /app

# Install the exact, locked dependency tree (reproducible builds).
COPY package.json package-lock.json ./
RUN npm ci

# Compile src/ -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Strip dev dependencies so the runtime stage gets a minimal node_modules.
RUN npm prune --omit=dev

############################
# Stage 2 — runtime
############################
FROM node:20.20.1-alpine AS runtime

LABEL org.opencontainers.image.title="store-ops-mcp" \
      org.opencontainers.image.description="Store Ops MCP server (stdio) — runs entirely inside Korral's private cloud" \
      org.opencontainers.image.vendor="Korral"

# Production runtime config. STORE_OPS_LOG_DIR points logs at a writable volume.
ENV NODE_ENV=production \
    STORE_OPS_LOG_DIR=/var/log/store-ops

WORKDIR /app

# Copy only what the runtime needs.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Tenant-owned, writable log directory; owned by the unprivileged "node" user
# that ships with the official image.
RUN mkdir -p "$STORE_OPS_LOG_DIR" \
    && chown -R node:node "$STORE_OPS_LOG_DIR" /app

# Never run as root.
USER node

# Declare the log location as a volume so audit/debug data persists on
# Korral-controlled storage rather than the container's writable layer.
VOLUME ["/var/log/store-ops"]

# This server communicates via JSON-RPC over stdio. The MCP client attaches to
# this process's stdin/stdout, so it must be run with an open stdin:
#   docker run -i --rm <image>
ENTRYPOINT ["node", "dist/index.js"]
