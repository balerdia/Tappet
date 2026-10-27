import { Cron } from "croner";
import { and, eq, inArray, isNull, lte, lt, or, schema, type Database } from "@tappet/db";
import type { ConnectorManifest, ConnectorRuntime } from "@tappet/connectors";
import { advance, type RunState } from "@tappet/workflow";
import type { ConnectConfig } from "../credentials.js";
import { actionResolverFor } from "./actions.js";
import { ACTIVE_STATUSES, loadDefinition, startWorkflowRun } from "./runs.js";

/**
 * The runner. Each tick starts scheduled workflows that are due and moves
 * every due run forward with the portable workflow runner. All state lives
 * in the database, so the process can stop and start (or sleep, as a
 * Cloudflare Container) without losing anything.
 */
export type RunnerDeps = {
  db: Database;
  manifests: ConnectorManifest[];
  runtimes: ConnectorRuntime[];
  connect?: ConnectConfig;
  now: () => Date;
  newId: (prefix: string) => string;
  /** How long a claimed run is off-limits to other runners. */
  leaseMs?: number;
  /** Most runs moved forward per tick. */
  batchSize?: number;
};

export async function tick(deps: RunnerDeps): Promise<{ started: number; advanced: number }> {
  const now = deps.now();
  const started = await startScheduledRuns(deps, now);
  const advanced = await advanceDueRuns(deps, now);
  return { started, advanced };
}

/**
 * Starts a run for each scheduled workflow whose time has come. After
 * downtime only the most recent missed slot fires, not one per slot.
 */
export async function startScheduledRuns(deps: RunnerDeps, now: Date): Promise<number> {
  const { db } = deps;
  const workflows = await db
    .select()
    .from(schema.workflows)
    .where(inArray(schema.workflows.status, [...ACTIVE_STATUSES]));

  let started = 0;
  for (const workflow of workflows) {
    if (workflow.activeVersion === null) continue;
    const definition = await loadDefinition(db, workflow.id, workflow.activeVersion);
    const trigger = definition?.trigger;
    if (trigger?.kind !== "schedule") continue;

    // Activation sets lastScheduledAt; this covers older rows.
    if (!workflow.lastScheduledAt) {
      await db
        .update(schema.workflows)
        .set({ lastScheduledAt: now.toISOString() })
        .where(eq(schema.workflows.id, workflow.id));
      continue;
    }

    let due: Date | undefined;
    try {
      const cron = new Cron(trigger.cron, { timezone: trigger.timezone, paused: true });
      let next = cron.nextRun(new Date(workflow.lastScheduledAt));
      for (let i = 0; next && next <= now && i < 10_000; i++) {
        due = next;
        next = cron.nextRun(next);
      }
      cron.stop();
    } catch {
      await flagWorkflow(db, workflow.id);
      continue;
    }
    if (!due) continue;

    const runId = await startWorkflowRun({
      db,
      workflow,
      triggerKey: `schedule:${due.toISOString()}`,
      trigger: { scheduledFor: due.toISOString() },
      newId: deps.newId,
      now,
    });
    await db
      .update(schema.workflows)
      .set({ lastScheduledAt: due.toISOString() })
      .where(eq(schema.workflows.id, workflow.id));
    if (runId) started++;
  }
  return started;
}

/** Moves forward every run that is new, or whose wait is over. */
export async function advanceDueRuns(deps: RunnerDeps, now: Date): Promise<number> {
  const nowIso = now.toISOString();
  const candidates = await deps.db
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(
      and(
        or(
          eq(schema.runs.status, "running"),
          and(eq(schema.runs.status, "waiting"), lte(schema.runs.wakeAt, nowIso)),
        ),
        or(isNull(schema.runs.leaseUntil), lt(schema.runs.leaseUntil, nowIso)),
      ),
    )
    .limit(deps.batchSize ?? 50);

  let advanced = 0;
  for (const { id } of candidates) {
    if (await advanceRun(deps, id, now)) advanced++;
  }
  return advanced;
}

/** Claims one run, moves it as far as it can go, and saves the result. */
export async function advanceRun(deps: RunnerDeps, runId: string, now: Date): Promise<boolean> {
  const { db } = deps;
  const nowIso = now.toISOString();

  // Claim it. If another runner got there first, nothing comes back.
  const [run] = await db
    .update(schema.runs)
    .set({ leaseUntil: new Date(now.getTime() + (deps.leaseMs ?? 5 * 60_000)).toISOString() })
    .where(
      and(
        eq(schema.runs.id, runId),
        or(isNull(schema.runs.leaseUntil), lt(schema.runs.leaseUntil, nowIso)),
      ),
    )
    .returning();
  if (!run) return false;

  const release = (fields: Partial<typeof schema.runs.$inferInsert> = {}) =>
    db
      .update(schema.runs)
      .set({ ...fields, leaseUntil: null })
      .where(eq(schema.runs.id, run.id));

  const [workflow] = await db
    .select()
    .from(schema.workflows)
    .where(eq(schema.workflows.id, run.workflowId));
  if (!workflow || !ACTIVE_STATUSES.has(workflow.status)) {
    await release(); // Paused: leave it where it is.
    return false;
  }

  try {
    const definition = await loadDefinition(db, run.workflowId, run.workflowVersion);
    if (!definition) throw new Error("This version of the automation is missing.");

    const result = await advance(definition, run.state as RunState, {
      now: () => now,
      resolveAction: actionResolverFor(deps, run.workspaceId, now),
    });

    const finished = result.status === "completed" || result.status === "failed";
    await release({
      state: result.state,
      status: result.status,
      wakeAt: result.status === "waiting" ? (result.wakeAt ?? null) : null,
      error: result.status === "failed" ? result.error.message : null,
      finishedAt: finished ? nowIso : null,
    });
    if (result.events.length) {
      await db.insert(schema.runEvents).values(
        result.events.map((e) => ({
          runId: run.id,
          workspaceId: run.workspaceId,
          at: e.at,
          path: e.path,
          type: e.type,
          message: e.message,
        })),
      );
    }
    if (result.status === "failed") await flagWorkflow(db, workflow.id);
  } catch (err) {
    // Something outside the workflow broke. Record it plainly; don't retry blindly.
    const message = err instanceof Error ? err.message : String(err);
    await release({ status: "failed", error: message, finishedAt: nowIso });
    await db.insert(schema.runEvents).values({
      runId: run.id,
      workspaceId: run.workspaceId,
      at: nowIso,
      path: "",
      type: "run.failed",
      message,
    });
    await flagWorkflow(db, workflow.id);
  }
  return true;
}

/** Shows the workflow as "Needs attention" without stopping it. */
async function flagWorkflow(db: Database, workflowId: string) {
  await db
    .update(schema.workflows)
    .set({ status: "needs_attention" })
    .where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.status, "running")));
}
