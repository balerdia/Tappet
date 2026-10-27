import { and, eq, inArray, lte, schema, type Database } from "@tappet/db";
import {
  createActionResolver,
  type ConnectorContext,
  type ConnectorRuntime,
} from "@tappet/connectors";
import {
  advance,
  connectorsUsed,
  latestScheduledRun,
  startRun,
  type AdvanceResult,
  type RunState,
  type WorkflowDefinition,
} from "@tappet/workflow";
import type { CredentialStore } from "./credentials.js";

// A scheduled run that was missed (the server was down, say) still starts if
// it's this recent. Older ones are skipped rather than firing hours late.
const SCHEDULE_CATCH_UP_MS = 60 * 60_000;

export type RunHostDeps = {
  db: Database;
  runtimes: ConnectorRuntime[];
  credentials?: CredentialStore;
  now: () => Date;
  newId: (prefix: string) => string;
};

export type RunSummary = {
  id: string;
  status: AdvanceResult["status"];
  error?: string;
  wakeAt?: string;
  /** What each finished action returned, keyed by step path. */
  outputs: Record<string, unknown>;
};

/**
 * The host side of the runner: loads credentials, calls `advance`, and saves
 * what happened. The runner stays pure; everything with I/O lives here.
 */
export function createRunHost(deps: RunHostDeps) {
  const { db } = deps;

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

  async function step(
    workspaceId: string,
    def: WorkflowDefinition,
    state: RunState,
  ): Promise<RunSummary> {
    const contexts = await contextsFor(workspaceId, def);
    const result = await advance(def, state, {
      resolveAction: createActionResolver(deps.runtimes, (c) => contexts.get(c)),
      now: deps.now,
    });

    const finished = result.status === "completed" || result.status === "failed";
    const error = result.status === "failed" ? result.error.message : undefined;
    const wakeAt = result.status === "waiting" ? result.wakeAt : undefined;
    await db
      .update(schema.runs)
      .set({
        status: result.status,
        state: result.state,
        wakeAt: wakeAt ?? null,
        error: error ?? null,
        finishedAt: finished ? deps.now().toISOString() : null,
      })
      .where(eq(schema.runs.id, state.runId));
    if (result.events.length) {
      await db.insert(schema.runEvents).values(
        result.events.map((e) => ({
          runId: state.runId,
          workspaceId,
          at: e.at,
          path: e.path,
          type: e.type,
          message: e.message,
        })),
      );
    }

    const outputs: Record<string, unknown> = {};
    for (const [path, entry] of Object.entries(result.state.journal)) {
      if (entry.type === "action" && entry.status === "succeeded") outputs[path] = entry.output;
    }
    return { id: state.runId, status: result.status, error, wakeAt, outputs };
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

  /**
   * Starts a run of the approved version. `triggerKey` identifies the event
   * that started it, so the same event can't start two runs: a repeat returns
   * undefined.
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
    const state = startRun(def, runId, opts.trigger, deps.now());
    const inserted = await db
      .insert(schema.runs)
      .values({
        id: runId,
        workspaceId: opts.workspaceId,
        workflowId: opts.workflowId,
        workflowVersion: opts.version,
        status: "running",
        state,
        triggerKey: opts.triggerKey,
      })
      .onConflictDoNothing()
      .returning({ id: schema.runs.id });
    if (!inserted.length) return undefined;
    return step(opts.workspaceId, def, state);
  }

  return {
    start,

    /**
     * Starts every scheduled automation whose latest scheduled time has come.
     * The scheduled time is the trigger key, so ticks that overlap, or several
     * servers ticking at once, still start each slot only once.
     */
    async startDueSchedules(): Promise<RunSummary[]> {
      const now = deps.now();
      const rows = await db
        .select({
          workspaceId: schema.workflows.workspaceId,
          workflowId: schema.workflows.id,
          version: schema.workflowVersions.version,
          definition: schema.workflowVersions.definition,
          approvedAt: schema.workflowVersions.approvedAt,
        })
        .from(schema.workflows)
        .innerJoin(
          schema.workflowVersions,
          and(
            eq(schema.workflowVersions.workflowId, schema.workflows.id),
            eq(schema.workflowVersions.version, schema.workflows.activeVersion),
          ),
        )
        .where(eq(schema.workflows.status, "running"));

      const results: RunSummary[] = [];
      for (const row of rows) {
        const trigger = (row.definition as WorkflowDefinition).trigger;
        if (trigger.kind !== "schedule" || !row.approvedAt) continue;
        let slot: Date | undefined;
        try {
          slot = latestScheduledRun(trigger, now);
        } catch {
          continue; // Validation stops bad schedules being turned on; skip any that slipped by.
        }
        // Nothing from before it was turned on, and nothing too stale.
        if (!slot || slot < new Date(row.approvedAt)) continue;
        if (now.getTime() - slot.getTime() > SCHEDULE_CATCH_UP_MS) continue;

        const run = await start({
          workspaceId: row.workspaceId,
          workflowId: row.workflowId,
          version: row.version,
          trigger: { scheduledFor: slot.toISOString() },
          triggerKey: `schedule:${slot.toISOString()}`,
        });
        if (run) results.push(run);
      }
      return results;
    },

    /** Carries on every run whose wait or retry is over. */
    async advanceDue(limit = 25): Promise<RunSummary[]> {
      const due = await db
        .select()
        .from(schema.runs)
        .where(
          and(
            inArray(schema.runs.status, ["waiting"]),
            lte(schema.runs.wakeAt, deps.now().toISOString()),
          ),
        )
        .limit(limit);
      const results: RunSummary[] = [];
      for (const run of due) {
        const def = await definitionFor(run.workflowId, run.workflowVersion);
        if (!def) continue;
        results.push(await step(run.workspaceId, def, run.state as RunState));
      }
      return results;
    },
  };
}

export type RunHost = ReturnType<typeof createRunHost>;

/** One beat of the clock: start what's scheduled, then carry on what's waiting. */
export async function tick(host: RunHost) {
  await host.startDueSchedules();
  await host.advanceDue();
}
