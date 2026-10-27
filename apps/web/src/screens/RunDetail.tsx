import { Link, useParams } from "react-router";
import { ApprovalButtons } from "../components/ApprovalButtons";
import type { RunSummary } from "../components/RunList";
import { Card, ErrorText, RunStatusBadge } from "../components/ui";
import { when } from "../format";
import { useApi } from "../useApi";

type RunEvent = { id: number; at: string; type: string; message: string };
type Detail = {
  run: Omit<RunSummary, "pendingApprovals">;
  pendingApprovals: RunSummary["pendingApprovals"];
  events: RunEvent[];
};

const EVENT_TONE: Record<string, string> = {
  "action.failed": "text-uncertain",
  "run.failed": "text-uncertain",
  "action.retry_scheduled": "text-inferred",
  "approval.requested": "text-inferred",
};

/** One run, step by step, in plain words. */
export function RunDetail() {
  const { id } = useParams();
  const { data, error, reload } = useApi<Detail>(`/runs/${id}`, { refreshMs: 4000 });

  return (
    <div className="space-y-6">
      <Link to="/activity" className="text-sm text-muted hover:text-ink">
        ← Activity
      </Link>
      <ErrorText>{error}</ErrorText>
      {data && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{data.run.workflowName}</h1>
              <p className="mt-1 text-sm text-muted">
                Started {when(data.run.startedAt)}
                {data.run.finishedAt && `, finished ${when(data.run.finishedAt)}`}
                {data.run.status === "waiting" &&
                  data.run.wakeAt &&
                  `. Carries on ${when(data.run.wakeAt)}`}
              </p>
            </div>
            <RunStatusBadge status={data.run.status} />
          </div>

          {data.pendingApprovals.map((approval) => (
            <Card key={approval.path} className="border-inferred/40">
              <p className="mb-3 font-medium">{approval.message}</p>
              <ApprovalButtons runId={data.run.id} path={approval.path} onDone={reload} />
            </Card>
          ))}

          {data.run.error && (
            <Card className="border-uncertain/40">
              <p className="font-medium text-uncertain">This run didn't finish</p>
              <p className="mt-1 text-sm">{data.run.error}</p>
            </Card>
          )}

          <Card>
            <h2 className="mb-2 text-sm font-semibold">What happened</h2>
            {data.events.length === 0 ? (
              <p className="text-sm text-muted">Nothing yet. It starts within a few seconds.</p>
            ) : (
              <ol className="divide-y divide-line">
                {data.events.map((e) => (
                  <li key={e.id} className="flex justify-between gap-4 py-2 text-sm">
                    <span className={EVENT_TONE[e.type] ?? ""}>{e.message}</span>
                    <time className="shrink-0 text-muted" dateTime={e.at}>
                      {new Date(e.at).toLocaleTimeString()}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
