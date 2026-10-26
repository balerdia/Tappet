# Architecture

This maps the PRD's five components onto the code, notes the decisions made in the scaffold, and lists what's still to build.

## Components

| PRD component      | Where                   | State                                                                  |
| ------------------ | ----------------------- | ---------------------------------------------------------------------- |
| Application        | `apps/web`, `apps/api`  | Five screens as stubs. API for workflows, connectors, activity, export |
| Integration layer  | `packages/connectors`   | Manifests for Gmail, Drive, Linear, HTTP, webhooks. HTTP action works  |
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

## Security notes

- Credentials are encrypted with AES-GCM (`apps/api/src/secrets.ts`); the key lives in the environment, never the database. The API never returns them.
- Organise is read-only toward source systems. Changes go through Automate, which requires approval.
- Content from sources is wrapped with `untrusted()` before it reaches a model. Model output is only ever a draft that must validate and be approved.
- Sign-in goes through an `Authenticator` interface (`apps/api/src/auth.ts`). Clerk is the managed default; the API verifies Clerk session tokens on every request. A self-hosted deployment could swap in another provider without touching the routes.
- Users link to the provider by `external_id`. Workspaces and memberships stay in our database, so Clerk holds identity only.
- Dev sign-in (`TAPPET_DEV_AUTH=1`) is for local work only. With neither it nor Clerk configured, every API route except `/api/health` returns 401.

## Not built yet

Roughly in milestone order:

1. **Connections**: OAuth flows (Google, Linear), credential storage, token refresh, Gmail/Drive/Linear runtimes.
2. **Organise**: retrieval across sources, commitment extraction (model), evidence UI, saved views.
3. **Sentence builder**: phrases become controls that edit the definition; progressive disclosure.
4. **Execute**: host loop that starts runs from triggers (with `runs.trigger_key` dedupe), advances due runs, and writes `run_events`. Schedules via Cron Triggers on Cloudflare and a timer on Node.
5. **Experience**: onboarding, workspace invites, activity detail, pause/stop/recover UI.
6. **Portability**: a standalone CLI that imports an export and runs it.
7. **Model adapters**: concrete providers behind `ModelProvider`.

## Open questions

- Licence split (AGPLv3 core / FSL app) pending legal review. Everything is MIT for now.
- Self-hosted sign-in: Clerk is a hosted service, so self-hosters need their own Clerk account until a local provider exists behind the same interface.
- How approval at activation relates to per-run approval for sensitive actions. Today: actions marked `sensitive` need a per-run approval; everything else is covered by approving the workflow.
