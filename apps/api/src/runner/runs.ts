import { and, eq, schema, type Database } from "@tappet/db";
import { startRun, type WorkflowDefinition } from "@tappet/workflow";

// Shared by the API (manual runs, approvals) and the runner. Kept free of
// connector code so the Worker bundle can use it.

export type WorkflowRow = typeof schema.workflows.$inferSelect;

/** Statuses whose runs should keep going. Paused, draft and others don't. */
export const ACTIVE_STATUSES = new Set<WorkflowRow["status"]>(["running", "needs_attention"]);

export async function loadDefinition(
  db: Database,
  workflowId: string,
  version: number,
): Promise<WorkflowDefinition | undefined> {
  const [row] = await db
    .select({ definition: schema.workflowVersions.definition })
    .from(schema.workflowVersions)
    .where(
      and(
        eq(schema.workflowVersions.workflowId, workflowId),
        eq(schema.workflowVersions.version, version),
      ),
    );
  // Only approved versions become active, and those were validated first.
  return row?.definition as WorkflowDefinition | undefined;
}

/**
 * Creates a run for the workflow's approved version. The trigger key makes
 * this idempotent: the same scheduled slot or event can't start two runs.
 * Returns the run id, or undefined if that trigger already started one.
 */
export async function startWorkflowRun(params: {
  db: Database;
  workflow: WorkflowRow;
  triggerKey: string;
  trigger: unknown;
  newId: (prefix: string) => string;
  now: Date;
}): Promise<string | undefined> {
  const { db, workflow } = params;
  if (workflow.activeVersion === null) return undefined;
  const definition = await loadDefinition(db, workflow.id, workflow.activeVersion);
  if (!definition) return undefined;

  const id = params.newId("run");
  const inserted = await db
    .insert(schema.runs)
    .values({
      id,
      workspaceId: workflow.workspaceId,
      workflowId: workflow.id,
      workflowVersion: workflow.activeVersion,
      status: "running",
      state: startRun(definition, id, params.trigger, params.now),
      triggerKey: params.triggerKey,
      startedAt: params.now.toISOString(),
    })
    .onConflictDoNothing()
    .returning({ id: schema.runs.id });
  return inserted[0]?.id;
}
