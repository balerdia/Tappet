import type { Hono } from "hono";
import { z } from "zod";
import { and, asc, desc, eq, inArray, schema } from "@tappet/db";
import { decideApproval, type RunState } from "@tappet/workflow";
import type { AppDeps, AppEnv } from "./app.js";
import { ACTIVE_STATUSES, startWorkflowRun } from "./runner/runs.js";

// Starting runs by hand, watching them, and answering approvals. The runner
// does the work; these routes only change what's stored.

type RunRow = typeof schema.runs.$inferSelect;
type EventRow = typeof schema.runEvents.$inferSelect;

function summarise(run: RunRow) {
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    status: run.status,
    error: run.error,
    wakeAt: run.wakeAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

/** Each approval the run is waiting on, with the question it asked. */
function pendingApprovals(run: RunRow, events: EventRow[]) {
  return Object.entries((run.state as RunState).journal)
    .filter(([, e]) => e.type === "approval" && e.status === "pending")
    .map(([path]) => ({
      path,
      message:
        events.find((e) => e.type === "approval.requested" && e.path === path)?.message ??
        "Approve this step?",
    }));
}

const RunNowBody = z.object({ trigger: z.unknown().optional() }).optional();
const ApprovalBody = z.object({
  path: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
});

export function registerRunRoutes(
  app: Hono<AppEnv>,
  deps: AppDeps,
  audit: (
    workspaceId: string,
    actorId: string,
    action: string,
    subject: string,
    detail?: unknown,
  ) => Promise<void>,
) {
  const { db } = deps;

  async function findRun(workspaceId: string, id: string) {
    const [run] = await db
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.id, id), eq(schema.runs.workspaceId, workspaceId)));
    return run;
  }

  /** Starts the approved version now. The runner picks it up on its next tick. */
  app.post("/workflows/:id/run", async (c) => {
    const workspaceId = c.get("workspaceId");
    const [workflow] = await db
      .select()
      .from(schema.workflows)
      .where(
        and(
          eq(schema.workflows.id, c.req.param("id")),
          eq(schema.workflows.workspaceId, workspaceId),
        ),
      );
    if (!workflow) return c.json({ error: "Not found." }, 404);
    if (!ACTIVE_STATUSES.has(workflow.status)) {
      return c.json({ error: "Turn this automation on before running it." }, 409);
    }
    const body = RunNowBody.parse(await c.req.json().catch(() => undefined));
    const runId = await startWorkflowRun({
      db,
      workflow,
      triggerKey: `manual:${deps.newId("t")}`,
      trigger: body?.trigger ?? {},
      newId: deps.newId,
      now: deps.now(),
    });
    await audit(workspaceId, c.get("userId"), "workflow.run_requested", workflow.id, { runId });
    return c.json({ runId, status: "running" }, 202);
  });

  /** Recent runs, newest first, with any question a run is waiting on. */
  app.get("/runs", async (c) => {
    const workspaceId = c.get("workspaceId");
    const workflowId = c.req.query("workflowId");
    const limit = Math.min(Number(c.req.query("limit")) || 30, 100);
    const rows = await db
      .select({ run: schema.runs, workflowName: schema.workflows.name })
      .from(schema.runs)
      .innerJoin(schema.workflows, eq(schema.workflows.id, schema.runs.workflowId))
      .where(
        workflowId
          ? and(eq(schema.runs.workspaceId, workspaceId), eq(schema.runs.workflowId, workflowId))
          : eq(schema.runs.workspaceId, workspaceId),
      )
      .orderBy(desc(schema.runs.startedAt))
      .limit(limit);

    const waiting = rows.filter((r) => r.run.status === "awaiting_approval").map((r) => r.run.id);
    const questions = waiting.length
      ? await db
          .select()
          .from(schema.runEvents)
          .where(
            and(
              inArray(schema.runEvents.runId, waiting),
              eq(schema.runEvents.type, "approval.requested"),
            ),
          )
      : [];

    return c.json({
      runs: rows.map(({ run, workflowName }) => ({
        ...summarise(run),
        workflowName,
        pendingApprovals: pendingApprovals(
          run,
          questions.filter((q) => q.runId === run.id),
        ),
      })),
    });
  });

  app.get("/runs/:id", async (c) => {
    const run = await findRun(c.get("workspaceId"), c.req.param("id"));
    if (!run) return c.json({ error: "Not found." }, 404);
    const [workflow] = await db
      .select({ name: schema.workflows.name })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, run.workflowId));
    const events = await db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, run.id))
      .orderBy(asc(schema.runEvents.id));
    return c.json({
      run: { ...summarise(run), workflowName: workflow?.name },
      pendingApprovals: pendingApprovals(run, events),
      events,
    });
  });

  /** Records a yes or no on a waiting approval, then hands the run back to the runner. */
  app.post("/runs/:id/approvals", async (c) => {
    const workspaceId = c.get("workspaceId");
    const run = await findRun(workspaceId, c.req.param("id"));
    if (!run) return c.json({ error: "Not found." }, 404);
    if (run.status !== "awaiting_approval") {
      return c.json({ error: "This run isn't waiting for approval." }, 409);
    }
    const body = ApprovalBody.parse(await c.req.json());
    let state: RunState;
    try {
      state = decideApproval(run.state as RunState, body.path, body.decision, c.get("userId"));
    } catch {
      return c.json({ error: "There's nothing waiting for approval there." }, 409);
    }
    // Only flip it if nobody else answered in the meantime.
    const updated = await db
      .update(schema.runs)
      .set({ state, status: "running" })
      .where(and(eq(schema.runs.id, run.id), eq(schema.runs.status, "awaiting_approval")))
      .returning({ id: schema.runs.id });
    if (!updated.length) return c.json({ error: "Someone else already answered." }, 409);
    const [who] = await db
      .select({ name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, c.get("userId")));
    const by = who?.name ?? who?.email;
    await db.insert(schema.runEvents).values({
      runId: run.id,
      workspaceId,
      at: deps.now().toISOString(),
      path: body.path,
      type: `approval.${body.decision}`,
      message: `${body.decision === "approved" ? "Approved" : "Declined"}${by ? ` by ${by}` : ""}.`,
    });
    await audit(workspaceId, c.get("userId"), `run.${body.decision}`, run.id, { path: body.path });
    return c.json({ id: run.id, status: "running" });
  });
}
