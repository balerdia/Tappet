import { Cron } from "croner";
import { and, eq, inArray, isNull, lt, lte, or, schema, type Database } from "@tappet/db";
import {
  createActionResolver,
  type ConnectorContext,
  type ConnectorRuntime,
} from "@tappet/connectors";
import {
  advance,
  connectorsUsed,
  startRun,
  type AdvanceResult,
  type RunState,
  type WorkflowDefinition,
  type WorkflowStatus,
} from "@tappet/workflow";
import type { CredentialStore } from "./credentials.js";

/** Workflows that are switched on. "Needs attention" still runs; it only asks someone to look. */
export const ACTIVE_STATUSES: ReadonlySet<WorkflowStatus> = new Set(["running", "needs_attention"]);

export type RunHostDeps = {
  db: Database;
  runtimes: ConnectorRuntime[];
  credentials?: CredentialStore;
  now: () => Date;
  newId: (prefix: string) => string;
  /** How long a claimed run is off-limits to other runners. */
  leaseMs?: number;
  /** Most runs moved forward per tick. */
  batchSize?: number;
};

export type RunSummary = {
  id: string;
  /** "running" means another host has it in hand right now. */
  status: AdvanceResult["status"] | "running";
  error?: string;
  wakeAt?: string;
  /** What each finished action returned, keyed by step path. */
  outputs: Record<string, unknown>;
};

type RunRow = typeof schema.runs.$inferSelect;

/**
 * The host side of the runner: loads credentials, calls `advance`, and saves
 * what happened. The runner stays pure; everything with I/O lives here.
 *
 * All state lives in the database, so any number of hosts (the Node server,
 * a Worker's Cron Trigger) can share the work. A run is claimed with a lease
 * before it's touched, so two ticks never do the same step twice.
 */
export function createRunHost(deps: RunHostDeps) {
  const { db } = deps;
  const leaseMs = deps.leaseMs ?? 5 * 60_000;

  async function contextsFor(workspaceId: string, def: WorkflowDefinition) {
    const contexts = new Map<string, ConnectorContext>();
    for (const connector of connectorsUsed(def)) {
      const runtime = deps.runtimes.find((r) => r.manifest.id === connector);
      if (!runtime) continue;
      if (runtime.manifest.auth.kind === "none") {
        contexts.set(connector, { credentials: {}, workspaceId });
        continue;
      }
      const ctx = await deps.credentials?.contextFor(workspaceId, connector);
      if (ctx) contexts.set(connector, ctx);
    }
    return contexts;
  }

  function describeAction(connector: string, action: string) {
    return deps.runtimes
      .find((r) => r.manifest.id === connector)
      ?.manifest.actions.find((a) => a.name === action)?.phrase;
  }

  async function definitionFor(workflowId: string, version: number) {
    const [row] = await db
      .select()
      .from(schema.workflowVersions)
      .where(
        and(
          eq(schema.workflowVersions.workflowId, workflowId),
          eq(schema.workflowVersions.version, version),
        ),
      );
    return row?.definition as WorkflowDefinition | undefined;
  }

  /** Takes a run for this host. Nothing comes back if another host has it. */
  async function claim(runId: string): Promise<RunRow | undefined> {
    const now = deps.now();
    const [run] = await db
      .update(schema.runs)
      .set({ leaseUntil: new Date(now.getTime() + leaseMs).toISOString() })
      .where(
        and(
          eq(schema.runs.id, runId),
          or(isNull(schema.runs.leaseUntil), lt(schema.runs.leaseUntil, now.toISOString())),
        ),
      )
      .returning();
    return run;
  }

  async function save(run: RunRow, fields: Partial<typeof schema.runs.$inferInsert>) {
    await db
      .update(schema.runs)
      .set({ ...fields, leaseUntil: null })
      .where(eq(schema.runs.id, run.id));
  }

  async function record(
    run: RunRow,
    events: { at: string; path: string; type: string; message: string }[],
  ) {
    if (!events.length) return;
    await db
      .insert(schema.runEvents)
      .values(events.map((e) => ({ ...e, runId: run.id, workspaceId: run.workspaceId })));
  }

  /** Shows the workflow as "Needs attention" without stopping it. */
  async function flagWorkflow(workflowId: string) {
    await db
      .update(schema.workflows)
      .set({ status: "needs_attention" })
      .where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.status, "running")));
  }

  /**
   * Claims one run, moves it as far as it can go, and saves the result.
   * Undefined when another host has it or its workflow is paused.
   */
  async function advanceRun(runId: string): Promise<RunSummary | undefined> {
    const run = await claim(runId);
    if (!run) return undefined;

    const [workflow] = await db
      .select({ status: schema.workflows.status })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, run.workflowId));
    if (!workflow || !ACTIVE_STATUSES.has(workflow.status)) {
      await save(run, {}); // Paused: leave it where it is until it's turned on again.
      return undefined;
    }

    const nowIso = deps.now().toISOString();
    try {
      const def = await definitionFor(run.workflowId, run.workflowVersion);
      if (!def) throw new Error("This version of the automation is missing.");
      const contexts = await contextsFor(run.workspaceId, def);
      const result = await advance(def, run.state as RunState, {
        resolveAction: createActionResolver(deps.runtimes, (c) => contexts.get(c)),
        describeAction,
        now: deps.now,
      });

      const finished = result.status === "completed" || result.status === "failed";
      const error = result.status === "failed" ? result.error.message : undefined;
      const wakeAt = result.status === "waiting" ? result.wakeAt : undefined;
      await save(run, {
        status: result.status,
        state: result.state,
        wakeAt: wakeAt ?? null,
        error: error ?? null,
        finishedAt: finished ? nowIso : null,
      });
      await record(run, result.events);
      if (result.status === "failed") await flagWorkflow(run.workflowId);

      const outputs: Record<string, unknown> = {};
      for (const [path, entry] of Object.entries(result.state.journal)) {
        if (entry.type === "action" && entry.status === "succeeded") outputs[path] = entry.output;
      }
      return { id: run.id, status: result.status, error, wakeAt, outputs };
    } catch (err) {
      // Something outside the workflow broke. Record it plainly; don't retry blindly.
      const error = err instanceof Error ? err.message : String(err);
      await save(run, { status: "failed", error, finishedAt: nowIso });
      await record(run, [{ at: nowIso, path: "", type: "run.failed", message: error }]);
      await flagWorkflow(run.workflowId);
      return { id: run.id, status: "failed", error, outputs: {} };
    }
  }

  /**
   * Starts a run of the approved version and takes it as far as it can go.
   * `triggerKey` identifies the event that started it, so the same event
   * can't start two runs; undefined means it already had one.
   */
  async function start(opts: {
    workspaceId: string;
    workflowId: string;
    version: number;
    trigger: unknown;
    triggerKey: string;
  }): Promise<RunSummary | undefined> {
    const def = await definitionFor(opts.workflowId, opts.version);
    if (!def) throw new Error("The approved version of this automation is missing.");
    const runId = deps.newId("run");
    const inserted = await db
      .insert(schema.runs)
      .values({
        id: runId,
        workspaceId: opts.workspaceId,
        workflowId: opts.workflowId,
        workflowVersion: opts.version,
        status: "running",
        state: startRun(def, runId, opts.trigger, deps.now()),
        triggerKey: opts.triggerKey,
      })
      .onConflictDoNothing()
      .returning({ id: schema.runs.id });
    if (!inserted.length) return undefined;
    // Another host may have picked it up already; it's in hand either way.
    return (await advanceRun(runId)) ?? { id: runId, status: "running", outputs: {} };
  }

  /**
   * Starts a run for each scheduled workflow whose time has come. After
   * downtime only the most recent missed slot fires, not one per slot.
   */
  async function startScheduled(): Promise<number> {
    const now = deps.now();
    const workflows = await db
      .select()
      .from(schema.workflows)
      .where(inArray(schema.workflows.status, [...ACTIVE_STATUSES]));

    let started = 0;
    for (const workflow of workflows) {
      if (workflow.activeVersion === null) continue;
      const def = await definitionFor(workflow.id, workflow.activeVersion);
      const trigger = def?.trigger;
      if (trigger?.kind !== "schedule") continue;

      // Activation sets this; it covers rows from before the column existed.
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
        const latestSince = (from: Date) => {
          let found: Date | undefined;
          let next = cron.nextRun(from);
          for (let i = 0; next && next <= now && i < 10_000; i++) {
            found = next;
            next = cron.nextRun(next);
          }
          return found;
        };
        // Look at the last day first, so a frequent schedule after a long
        // outage doesn't walk every missed slot.
        const last = new Date(workflow.lastScheduledAt);
        const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
        due = (last < dayAgo ? latestSince(dayAgo) : undefined) ?? latestSince(last);
        cron.stop();
      } catch {
        await flagWorkflow(workflow.id);
        continue;
      }
      if (!due) continue;

      // Move the marker first, so a slow run can't make the next tick fire it again.
      await db
        .update(schema.workflows)
        .set({ lastScheduledAt: due.toISOString() })
        .where(eq(schema.workflows.id, workflow.id));
      const run = await start({
        workspaceId: workflow.workspaceId,
        workflowId: workflow.id,
        version: workflow.activeVersion,
        trigger: { scheduledFor: due.toISOString() },
        triggerKey: `schedule:${due.toISOString()}`,
      });
      if (run) started++;
    }
    return started;
  }

  /** Carries on every run that's new, or whose wait or retry is over. */
  async function advanceDue(): Promise<RunSummary[]> {
    const nowIso = deps.now().toISOString();
    const due = await db
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
      .limit(deps.batchSize ?? 25);
    const results: RunSummary[] = [];
    for (const { id } of due) {
      const result = await advanceRun(id);
      if (result) results.push(result);
    }
    return results;
  }

  return {
    start,
    advanceRun,
    advanceDue,
    startScheduled,
    /** One pass of the runner: start what's scheduled, then move everything due. */
    async tick() {
      const started = await startScheduled();
      const advanced = (await advanceDue()).length;
      return { started, advanced };
    },
  };
}

export type RunHost = ReturnType<typeof createRunHost>;
