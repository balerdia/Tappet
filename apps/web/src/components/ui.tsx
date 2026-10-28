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

export function AskBox({
  placeholder,
  action,
  onAsk,
  initial = "",
  busy,
}: {
  placeholder: string;
  action: string;
  onAsk?: (text: string) => void;
  initial?: string;
  busy?: boolean;
}) {
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const text = String(new FormData(e.currentTarget).get("q") ?? "").trim();
        if (text) onAsk?.(text);
      }}
    >
      <input
        name="q"
        key={initial}
        defaultValue={initial}
        className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
        placeholder={placeholder}
        aria-label={placeholder}
      />
      <button
        disabled={busy}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-50"
      >
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

const BUTTON_TONE = {
  primary: "bg-accent font-medium text-surface hover:opacity-90",
  secondary: "border border-line hover:border-accent",
  quiet: "text-muted hover:text-ink",
};

export function Button({
  children,
  onClick,
  tone = "secondary",
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: keyof typeof BUTTON_TONE;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-sm disabled:opacity-50 ${BUTTON_TONE[tone]}`}
    >
      {children}
    </button>
  );
}

export type RunStatus = "running" | "waiting" | "awaiting_approval" | "completed" | "failed";

const RUN_LABEL: Record<RunStatus, [string, string]> = {
  running: ["Running", "text-accent border-accent/40 bg-accent-soft"],
  waiting: ["Waiting", "text-muted border-line"],
  awaiting_approval: ["Needs your approval", "text-inferred border-inferred/40"],
  completed: ["Done", "text-muted border-line"],
  failed: ["Failed", "text-uncertain border-uncertain/40"],
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const [label, tone] = RUN_LABEL[status];
  return (
    <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`}>
      {label}
    </span>
  );
}

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <p className="text-sm text-uncertain">{children}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-line p-8 text-center text-muted">
      {children}
    </p>
  );
}
