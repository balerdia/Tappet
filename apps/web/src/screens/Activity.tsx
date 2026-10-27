import { Link } from "react-router";
import { ApprovalButtons } from "../components/ApprovalButtons";
import { RunList, type RunSummary } from "../components/RunList";
import { Card, ErrorText, PageHeader } from "../components/ui";
import { when } from "../format";
import { useApi } from "../useApi";

export function Activity() {
  return (
    <div>
      <PageHeader
        title="Activity"
        intro="Everything your automations have done, and anything that needs you."
      />
      <NeedsYou />
      <Card>
        <h2 className="mb-2 text-sm font-semibold">Recent runs</h2>
        <RunList />
      </Card>
    </div>
  );
}

/** Steps waiting for a yes or no. Shown first because nothing moves until they're answered. */
function NeedsYou() {
  const { data, error, reload } = useApi<{ runs: RunSummary[] }>("/runs?limit=100", {
    refreshMs: 5000,
  });
  const waiting = data?.runs.filter((r) => r.pendingApprovals.length > 0) ?? [];
  if (error) return <ErrorText>{error}</ErrorText>;
  if (waiting.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="mb-3 text-sm font-semibold">Needs you</h2>
      <div className="space-y-3">
        {waiting.flatMap((run) =>
          run.pendingApprovals.map((approval) => (
            <Card key={`${run.id}:${approval.path}`} className="border-inferred/40">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="font-medium">{approval.message}</p>
                  <p className="text-sm text-muted">
                    <Link to={`/activity/runs/${run.id}`} className="hover:text-accent">
                      {run.workflowName}
                    </Link>
                    , started {when(run.startedAt)}
                  </p>
                </div>
                <ApprovalButtons runId={run.id} path={approval.path} onDone={reload} />
              </div>
            </Card>
          )),
        )}
      </div>
    </section>
  );
}
