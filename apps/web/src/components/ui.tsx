import type { ReactNode } from "react";
import { WORKFLOW_STATUSES, type WorkflowStatus } from "@tappet/workflow";

export function PageHeader({ title, intro }: { title: string; intro?: string }) {
  return (
    <div className="mb-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {intro && <p className="mt-2 max-w-2xl text-muted">{intro}</p>}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-line bg-surface p-5 ${className}`}>{children}</div>
  );
}

export function AskBox({ placeholder, action }: { placeholder: string; action: string }) {
  return (
    <form className="flex gap-2" onSubmit={(e) => e.preventDefault()}>
      <input
        className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
        placeholder={placeholder}
        aria-label={placeholder}
      />
      <button className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface hover:opacity-90">
        {action}
      </button>
    </form>
  );
}

export function Chip({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border border-line px-3 py-1 text-sm text-muted hover:border-accent hover:text-ink"
    >
      {children}
    </button>
  );
}

const STATUS_TONE: Record<WorkflowStatus, string> = {
  draft: "text-muted border-line",
  needs_connection: "text-inferred border-inferred/40",
  needs_review: "text-inferred border-inferred/40",
  ready: "text-accent border-accent/40",
  running: "text-accent border-accent/40 bg-accent-soft",
  paused: "text-muted border-line",
  needs_attention: "text-uncertain border-uncertain/40",
  completed: "text-muted border-line",
  failed: "text-uncertain border-uncertain/40",
};

export function StatusBadge({ status }: { status: WorkflowStatus }) {
  return (
    <span
      className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}
    >
      {WORKFLOW_STATUSES[status]}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-line p-8 text-center text-muted">
      {children}
    </p>
  );
}
