# Tappet

Get your apps working together. Without all the work.

Tappet connects the business software people already use, organises scattered information, and automates everyday work. It has two modes that share one set of connections and permissions:

- **Organise** – find, relate and explain information across apps, with evidence.
- **Automate** – build processes from plain sentences, review them, approve them, and let them run.

Status: early scaffold. See [docs/architecture.md](docs/architecture.md) for how the pieces fit and what's next.

## Layout

```
apps/
  web/            React app (Vite, React Router, Tailwind)
  api/            Hono API. Runs on Node/Docker (src/node.ts) or Cloudflare Workers (src/worker.ts)
packages/
  workflow/       Workflow definition schema, validation, readable sentences, portable runner
  connectors/     Connector manifests and runtimes (Gmail, Drive, Linear, HTTP, webhooks)
  information/    Findings, evidence, certainty, commitment coverage (Organise)
  intelligence/   Provider-neutral model interface, request interpretation, untrusted-content handling
  db/             Drizzle schema and migrations. SQLite for Node/Docker, D1 for Cloudflare
```

## Getting started

Needs Node 22+ and pnpm 10.

```sh
pnpm install
pnpm dev          # API on :8787 (dev sign-in) and web on :5173
pnpm test
pnpm typecheck
```

The dev server uses a local SQLite file in `data/` and a built-in development user. There is no real sign-in yet.

### Docker (self-hosted)

```sh
docker build -t tappet .
docker run -p 8787:8787 -v tappet-data:/data tappet
```

### Cloudflare (managed)

```sh
pnpm --filter @tappet/web build
cd apps/api
wrangler d1 create tappet                   # put the id in wrangler.toml
wrangler d1 migrations apply tappet --local
pnpm dev:worker
```

### Database changes

Edit `packages/db/src/schema.ts`, then:

```sh
pnpm db:generate
```

Migrations in `packages/db/migrations` are applied on start by the Node server and by `wrangler d1 migrations apply` on Cloudflare.

## Licence

MIT for now. The PRD proposes AGPLv3 for the portable core and FSL 1.1 for the full application; that split is pending legal review and hasn't been applied.
