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
  pieces/         Runs Activepieces pieces as connector actions (Node only)
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

The dev server uses a local SQLite file in `data/`.

### Sign-in

Sign-in uses [Clerk](https://clerk.com). Set these environment variables to turn it on:

| Variable                     | Where | What                                                                                |
| ---------------------------- | ----- | ----------------------------------------------------------------------------------- |
| `VITE_CLERK_PUBLISHABLE_KEY` | web   | Publishable key (`pk_…`) from the Clerk Dashboard                                   |
| `CLERK_SECRET_KEY`           | API   | Secret key (`sk_…`). Never expose this to the browser                               |
| `CLERK_AUTHORIZED_PARTIES`   | API   | Comma-separated origins allowed to sign in. `pnpm dev` sets `http://localhost:5173` |

Without the keys, `pnpm dev` falls back to a built-in development user (`TAPPET_DEV_AUTH=1`). That fallback is for local work only: with neither Clerk nor `TAPPET_DEV_AUTH` set, the API refuses every request except `/api/health`.

On Cloudflare, set the secret with `wrangler secret put CLERK_SECRET_KEY` and the allowed origins in `wrangler.toml`.

Each person gets their own workspace the first time they sign in. Workspaces live in our database; Clerk only tells us who someone is.

### Connecting apps

To let people connect apps, set:

| Variable                                   | What                                                            |
| ------------------------------------------ | --------------------------------------------------------------- |
| `CREDENTIALS_KEY`                          | Encrypts stored tokens. Generate with `openssl rand -base64 32` |
| `APP_URL`                                  | Where the web app lives. Defaults to `http://localhost:5173`    |
| `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` | From a Linear OAuth app (Settings → API → OAuth applications)   |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | From a Google Cloud OAuth client                                |

Register `APP_URL` + `/connections/callback` (e.g. `http://localhost:5173/connections/callback`) as the redirect address with each app. Apps without credentials show as "Coming soon".

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
