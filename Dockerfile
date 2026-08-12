# syntax=docker/dockerfile:1

# ---------- dependencies ----------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci

# ---------- build ----------
FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    WEB_DIST=/app/apps/web/dist \
    # Persisted application state (chat transcripts today, the database later).
    DATA_DIR=/data \
    # Codex CLI stores its config and OAuth credentials here. Mount a volume at
    # this path so `codex login` survives container restarts and image updates.
    CODEX_HOME=/data/codex

# The Codex SDK drives the Codex CLI, so the CLI has to exist in the image.
RUN npm install -g @openai/codex@0.147.0 && npm cache clean --force

WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/server/package.json apps/server/package.json
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist

RUN mkdir -p /data/codex && chown -R node:node /data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
