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

The dev server uses a local SQLite file in `data/`. Without Clerk keys it signs everyone in as a built-in development user.

### Configuration

All optional. Each one switches a feature on.

| Variable                     | Used by | What it does                                                                                        |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `CLERK_SECRET_KEY`           | API     | Real sign-in with Clerk. The first signed-in request creates the person's account and workspace.    |
| `VITE_CLERK_PUBLISHABLE_KEY` | Web     | Shows Clerk's sign-in and sign-up pages. Set both Clerk keys or neither.                            |
| `CREDENTIALS_KEY`            | API     | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts stored app tokens.                    |
| `LINEAR_CLIENT_ID`           | API     | Linear OAuth app. Needs `CREDENTIALS_KEY` too.                                                      |
| `LINEAR_CLIENT_SECRET`       | API     |                                                                                                     |
| `GOOGLE_CLIENT_ID`           | API     | One Google OAuth app for Gmail and Google Drive. Needs `CREDENTIALS_KEY` too. Node and Docker only. |
| `GOOGLE_CLIENT_SECRET`       | API     |                                                                                                     |
| `APP_URL`                    | API     | Public address of the web app, e.g. `https://app.example.com`. Defaults to the request origin.      |
| `TAPPET_DEV_AUTH`            | API     | `1` forces dev sign-in, `0` turns it off. `pnpm dev` uses `auto`: on unless Clerk is set.           |

Each app calls back to `<APP_URL>/api/connections/<app>/callback`. For local work:

- **Google** (Google Cloud console → APIs & Services → Credentials → OAuth client ID, type "Web application"): add `http://localhost:5173/api/connections/gmail/callback` and `http://localhost:5173/api/connections/drive/callback` as authorised redirect URIs, and enable the Gmail API and Google Drive API for the project.
- **Linear**: add `http://localhost:5173/api/connections/linear/callback`.

Gmail and Google Drive run on [Activepieces](https://www.activepieces.com) pieces, which need Node. They work with `pnpm dev`, the Node server and Docker, but not on Cloudflare Workers.

### Docker (self-hosted)

```sh
docker build -t tappet --build-arg VITE_CLERK_PUBLISHABLE_KEY=pk_... .
docker run -p 8787:8787 -v tappet-data:/data \
  -e CLERK_SECRET_KEY -e CREDENTIALS_KEY -e GOOGLE_CLIENT_ID -e GOOGLE_CLIENT_SECRET \
  -e APP_URL=http://localhost:8787 tappet
```

The publishable key is baked into the web app when it's built; the rest are read when the server starts. Leave out the Clerk key and set `-e TAPPET_DEV_AUTH=1` to try it without sign-in. With `APP_URL=http://localhost:8787`, the Linear callback to register is `http://localhost:8787/api/connections/linear/callback`.

### Trying it out

1. Sign up, then open **Connections** and connect Gmail and Google Drive.
2. **Organise**: ask about a project, customer or deadline. Findings link to the emails, files and tasks they came from.
3. **Automate**: pick "Build your own", e.g. every Friday at 16:00, create a file in Google Drive, ask me first, then send an email. Save it, review it, turn it on.
4. **Activity**: answer approvals under "Needs you" and see what each run did.

### Cloudflare (managed)

```sh
pnpm --filter @tappet/web build
cd apps/api
wrangler d1 create tappet                   # put the id in wrangler.toml
wrangler d1 migrations apply tappet --local
wrangler secret put CLERK_SECRET_KEY        # and CREDENTIALS_KEY, LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET
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
