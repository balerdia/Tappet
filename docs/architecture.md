# Architecture

This maps the PRD's five components onto the code, notes the decisions made in the scaffold, and lists what's still to build.

## Components

| PRD component      | Where                   | State                                                                  |
| ------------------ | ----------------------- | ---------------------------------------------------------------------- |
| Application        | `apps/web`, `apps/api`  | Five screens as stubs. API for workflows, connectors, activity, export |
| Integration layer  | `packages/connectors`   | Manifests, our own OAuth for connecting apps, HTTP action              |
| Integration layer  | `packages/pieces`       | Runs Activepieces pieces as connector actions (Node only). Linear done |
| Information layer  | `packages/information`  | Finding/evidence/certainty types. Commitment-vs-task coverage check    |
| Automation engine  | `packages/workflow`     | Schema, validation, sentences and a working replay-based runner        |
| Intelligence layer | `packages/intelligence` | Model interface, request → draft workflow, untrusted-content wrapper   |
| Storage            | `packages/db`           | Drizzle schema + first migration. SQLite (Node/Docker) and D1          |

## Workflow definitions

`packages/workflow/src/schema.ts` is the single source of truth. The sentence builder and natural-language editing both produce this structure, and the runner executes it. Phrases map to definition nodes:

| Phrase                | Node                              |
| --------------------- | --------------------------------- |
| When…                 | `trigger`                         |
| If… / Otherwise…      | `if` with `then` / `otherwise`    |
| And / Or…             | `and` / `or` conditions           |
| Then…                 | `action`                          |
| For each…             | `forEach` (always has `maxItems`) |
| If nothing is found…  | `forEach.ifEmpty`                 |
| Wait until…           | `wait` (duration, time, or event) |
| Keep doing this until | `repeat` (always has `maxTimes`)  |
| Stop when…            | `repeat.stopWhen` or `stop`       |

Definitions are versioned (`schemaVersion` for the format, `version` per workflow). Saved versions are immutable; an edit creates a new version and the running version stays as approved until someone approves the new one.

`validateWorkflow` blocks combinations the builder should never allow: references to steps that haven't run, loop outputs used outside the loop, steps after a stop, unknown actions, missing inputs, and sensitive actions without an approval.

## Runner

`advance(definition, state, deps)` walks the definition from the top on every call and checks the run's journal. Finished work is replayed from the journal, not repeated. When the run has to wait (delay, approval, external event, retry backoff) it returns and the host saves the state. Calling it again later carries on.

Why replay: it keeps the runner pure and portable. It needs no long-lived process, so it fits Workers, Node, a cron tick or a queue consumer equally well. Exported workflows can run anywhere the package runs.

Each action gets an idempotency key (`runId:path`) that's stable across retries. That prevents duplicates only where the external API honours it, so we shouldn't claim exactly-once delivery in general.

## Connecting apps

Decided October 2026, after a spike:

- **Connecting is ours.** We run our own OAuth apps (Google, Linear, later Microsoft) so every app gets one-click "Connect", with no middleman and no per-call fees. Clerk handles sign-in only. Composio is not used: per-call pricing clashes with the no-hidden-fees principle.
- **Flow.** `POST /api/connections/:connector/start` returns the app's consent page. The app sends the person back to the web app's `/connections/callback`, which posts the code to `POST /api/connections/complete`. Running the last step as a signed-in API call means we can check the same person started it. The OAuth `state` is encrypted, carries the PKCE verifier, expires after 10 minutes, and is tied to the person and workspace. One redirect address serves every provider.
- **Tokens** are encrypted at rest and renewed automatically (`accessTokenFor` in `apps/api/src/credentials.ts`). If renewal fails, the connection is marked "needs reconnecting" so it shows on the Connections screen. Disconnecting deletes the tokens and asks the app to revoke them.
- **Actions come from Activepieces pieces** (MIT, outside their commercially licensed directories). They run directly in our runner, with no Activepieces server. `packages/pieces` maps our own action and input names onto each piece, so saved workflows don't depend on Activepieces naming. Versions are pinned exactly. Pieces capture `fetch` when they first load, so tests install fakes before loading them.
- **Where pieces run.** Not on Workers: one piece is about 2 MB, the Google piece mishandled compressed responses under Workers' Node compatibility, and Workers cap total size at 3–10 MB compressed. The runner runs on Node: in Docker for self-hosting, and as a Cloudflare Container for the managed service, woken by a Worker cron trigger. The API and web app stay on Workers. Containers can't bind D1 directly, so the runner will reach the database through the Worker.
- **Things to watch.** Gmail read access is a Google "restricted" scope: fine for up to 100 test users, but production needs Google verification and a yearly security assessment. The Gmail piece asks for broader scopes than we need; we request only read and send. The Linear piece expects an API key; Linear accepts our OAuth token in its place.

## Security notes

- Credentials are encrypted with AES-GCM (`apps/api/src/secrets.ts`); the key lives in the environment, never the database. The API never returns them.
- Organise is read-only toward source systems. Changes go through Automate, which requires approval.
- Content from sources is wrapped with `untrusted()` before it reaches a model. Model output is only ever a draft that must validate and be approved.
- Sign-in goes through an `Authenticator` interface (`apps/api/src/auth.ts`). Clerk is the managed default; the API verifies Clerk session tokens on every request. A self-hosted deployment could swap in another provider without touching the routes.
- Users link to the provider by `external_id`. Workspaces and memberships stay in our database, so Clerk holds identity only.
- Dev sign-in (`TAPPET_DEV_AUTH=1`) is for local work only. With neither it nor Clerk configured, every API route except `/api/health` returns 401.

## Not built yet

Roughly in milestone order:

1. **Connections**: Google OAuth client and Gmail/Drive pieces (Linear and the shared flow are done). Showing which account is connected.
2. **Organise**: retrieval across sources, commitment extraction (model), evidence UI, saved views.
3. **Sentence builder**: phrases become controls that edit the definition; progressive disclosure.
4. **Execute**: the Node runner service that starts runs from triggers (with `runs.trigger_key` dedupe), advances due runs, and writes `run_events`. Woken by Cron Triggers on Cloudflare and a timer on Node.
5. **Experience**: onboarding, workspace invites, activity detail, pause/stop/recover UI.
6. **Portability**: a standalone CLI that imports an export and runs it.
7. **Model adapters**: concrete providers behind `ModelProvider`.

## Open questions

- Licence split (AGPLv3 core / FSL app) pending legal review. Everything is MIT for now.
- Self-hosted sign-in: Clerk is a hosted service, so self-hosters need their own Clerk account until a local provider exists behind the same interface.
- Cloudflare Containers was in public beta at last check; confirm general availability and pricing before relying on it.
- How approval at activation relates to per-run approval for sensitive actions. Today: actions marked `sensitive` need a per-run approval; everything else is covered by approving the workflow.
