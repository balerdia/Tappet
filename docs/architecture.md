# Architecture

This maps the PRD's five components onto the code, notes the decisions made in the scaffold, and lists what's still to build.

## Components

| PRD component      | Where                   | State                                                                    |
| ------------------ | ----------------------- | ------------------------------------------------------------------------ |
| Application        | `apps/web`, `apps/api`  | Five screens as stubs. API for workflows, connectors, activity, export   |
| Integration layer  | `packages/connectors`   | Manifests for Gmail, Drive, Linear, HTTP, webhooks. HTTP and Linear work |
| Information layer  | `packages/information`  | Finding/evidence/certainty types. Commitment-vs-task coverage check      |
| Automation engine  | `packages/workflow`     | Schema, validation, sentences and a working replay-based runner          |
| Intelligence layer | `packages/intelligence` | Model interface, request → draft workflow, untrusted-content wrapper     |
| Storage            | `packages/db`           | Drizzle schema + first migration. SQLite (Node/Docker) and D1            |

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
- Sign-in is Clerk. The web app sends the session token as a bearer token; the API verifies it with `@clerk/backend` and creates the user, workspace and membership on first sight (`apps/api/src/auth.ts`). The workspace id is derived from the user id so racing first requests can't create two.
- Dev sign-in (`TAPPET_DEV_AUTH=1`) is for local work only. Without it, every API route except `/api/health` and OAuth callbacks needs a valid Clerk token.
- OAuth callbacks carry no sign-in token, so they're trusted only when the `state` matches a single-use row in `oauth_states` (10 minute expiry) and the `tappet_oauth` cookie set in the same browser when the flow started.
- Turning an automation on is refused (status `needs_connection`) while any app it uses isn't connected or has no runtime yet.

## Connections and runs

`POST /api/connections/:connector/start` returns the provider's sign-in address; the callback exchanges the code, encrypts the tokens and stores one connection per app per workspace. Tokens close to expiry are refreshed before each run (`apps/api/src/credentials.ts`); a failed refresh marks the connection `needs_reauth`.

`POST /api/workflows/:id/runs` starts a run of the approved version for automations with a `manual` trigger. `apps/api/src/runs.ts` loads credentials, calls `advance`, saves the run and writes `run_events` for Activity.

The runner's `tick` does two things. It starts scheduled automations whose time has come (cron in the workflow's time zone, via croner; only the latest missed slot fires after downtime, and turning on never fires a slot from before), then carries on every run that's new or whose wait or retry is over. It runs every 15 seconds on Node (`RUNNER_INTERVAL_MS`; `RUNNER=0` turns it off) and every minute from the Cron Trigger on Cloudflare.

All run state is in the database, so several hosts can tick at once. Before touching a run, a host claims it by setting `runs.lease_until` in a conditional update; anyone else skips it until the lease ends. A run that fails marks its automation "Needs attention" but leaves it on. A paused automation's runs stay where they are until it's turned on again.

Approvals: `GET /api/runs` and `GET /api/runs/:id` list what each run is waiting on, and `POST /api/runs/:id/approvals` records a yes or no (only once) and carries the run on straight away. Activity shows these under "Needs you".

## Not built yet

Roughly in milestone order:

1. **Connections**: Google OAuth and the Gmail/Drive runtimes. (Linear, credential storage and refresh are done.)
2. **Organise**: retrieval across sources, commitment extraction (model), evidence UI, saved views.
3. **Sentence builder**: phrases become controls that edit the definition; progressive disclosure.
4. **Execute**: start runs from event and webhook triggers (with `runs.trigger_key` dedupe). Manual runs, schedules, approvals and resuming due runs are done.
5. **Experience**: onboarding, activity detail, stop/recover UI, approving pending steps. (Sign-in is done.)
6. **Portability**: a standalone CLI that imports an export and runs it.
7. **Model adapters**: concrete providers behind `ModelProvider`.

## Open questions

- Licence split (AGPLv3 core / FSL app) pending legal review. Everything is MIT for now.
- How approval at activation relates to per-run approval for sensitive actions. Today: actions marked `sensitive` need a per-run approval; everything else is covered by approving the workflow.
