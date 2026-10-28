# Self-hosted image: API + built web app on Node, data in a SQLite volume.
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 compiles from source when no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY . .
# Baked into the web app at build time: docker build --build-arg VITE_CLERK_PUBLISHABLE_KEY=pk_...
ARG VITE_CLERK_PUBLISHABLE_KEY=""
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
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
