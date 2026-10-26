# Self-hosted image: API + built web app on Node, data in a SQLite volume.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @tappet/web build

FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY --from=build /app /app
ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_PATH=/data/tappet.sqlite \
    WEB_DIST=/app/apps/web/dist
VOLUME /data
EXPOSE 8787
CMD ["pnpm", "--filter", "@tappet/api", "start"]
