import { Link } from "react-router";
import { when } from "../format";
import { useApi } from "../useApi";
import { Empty, ErrorText, RunStatusBadge, type RunStatus } from "./ui";

export type RunSummary = {
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  error: string | null;
  wakeAt: string | null;
  startedAt: string;
  finishedAt: string | null;
  pendingApprovals: { path: string; message: string }[];
};

/** Recent runs, newest first. Keeps itself up to date while visible. */
export function RunList({
  workflowId,
  showName = true,
}: {
  workflowId?: string;
  showName?: boolean;
}) {
  const query = workflowId ? `?workflowId=${encodeURIComponent(workflowId)}&limit=10` : "";
  const { data, error } = useApi<{ runs: RunSummary[] }>(`/runs${query}`, { refreshMs: 5000 });

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!data) return null;
  if (data.runs.length === 0) return <Empty>Nothing has run yet.</Empty>;

  return (
    <ul className="divide-y divide-line">
      {data.runs.map((run) => (
        <li key={run.id}>
          <Link
            to={`/activity/runs/${run.id}`}
            className="flex items-center justify-between gap-4 py-2.5 text-sm hover:text-accent"
          >
            <span className="min-w-0">
              {showName && <span className="font-medium">{run.workflowName} </span>}
              <span className="text-muted">started {when(run.startedAt)}</span>
              {run.error && <span className="block truncate text-uncertain">{run.error}</span>}
            </span>
            <RunStatusBadge status={run.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
