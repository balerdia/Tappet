# Self-hosted image: API + built web app on Node, data in a SQLite volume.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
# The publishable key is baked into the web build. It's public, so a build arg is fine.
# Pass CLERK_SECRET_KEY at run time instead: docker run -e CLERK_SECRET_KEY=…
ARG VITE_CLERK_PUBLISHABLE_KEY
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
