/** Workflow statuses as people see them. Every screen uses these labels. */
export const WORKFLOW_STATUSES = {
  draft: "Draft",
  needs_connection: "Needs connection",
  needs_review: "Needs review",
  ready: "Ready to activate",
  running: "Running",
  paused: "Paused",
  needs_attention: "Needs attention",
  completed: "Completed",
  failed: "Failed",
} as const;

export type WorkflowStatus = keyof typeof WORKFLOW_STATUSES;

export const RUN_STATUSES = [
  "running",
  "waiting",
  "awaiting_approval",
  "completed",
  "failed",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
