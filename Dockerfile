# Hive server + built SPA in one image.
# Redis and Postgres live on 192.168.0.117 and are not part of this image.

FROM node:22-alpine AS build
WORKDIR /app

# Install with the full workspace manifest set so the lockfile is honoured.
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/mcp/package.json packages/mcp/
COPY packages/agent/package.json packages/agent/
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN npm run build --workspace @hive/shared \
 && npm run build --workspace @hive/server \
 && npm run build --workspace @hive/web

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
# Only the server's runtime tree — the SPA is static output, the MCP server and
# daemon are installed per-machine rather than shipped in this image.
RUN npm ci --omit=dev --workspace @hive/shared --workspace @hive/server

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist

# Uploads must outlive the container; compose mounts a volume here.
RUN mkdir -p /app/uploads
ENV HIVE_UPLOAD_DIR=/app/uploads

EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:7777/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
