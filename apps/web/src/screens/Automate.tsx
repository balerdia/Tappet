import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  connectorsUsed,
  examples,
  type SentenceLine,
  type ValidationIssue,
  type WorkflowDefinition,
  type WorkflowStatus,
} from "@tappet/workflow";
import { api, ApiError } from "../api";
import { useApi } from "../useApi";
import { SentenceView } from "../components/SentenceView";
import { AskBox, Card, Chip, PageHeader, StatusBadge } from "../components/ui";

// Schedules run in the timezone of whoever sets them up.
const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const inMyTimezone = (def: WorkflowDefinition): WorkflowDefinition =>
  def.trigger.kind === "schedule"
    ? { ...def, trigger: { ...def.trigger, timezone: browserTimezone } }
    : def;

const STARTERS: { label: string; definition: WorkflowDefinition }[] = [
  { label: "Add a task to Linear", definition: examples.linearTaskExample },
  {
    label: "Add a Linear task every weekday",
    definition: inMyTimezone(examples.linearScheduledExample),
  },
  { label: "Tell me about new enquiries", definition: examples.simpleExample },
  { label: "Welcome new customers", definition: examples.conditionalExample },
  {
    label: "Remind people about overdue tasks",
    definition: inMyTimezone(examples.advancedExample),
  },
];

type Preview = { ok: boolean; issues: ValidationIssue[]; sentences: SentenceLine[] };
type Workflow = {
  id: string;
  name: string;
  status: WorkflowStatus;
  activeVersion: number | null;
  trigger?: string;
  nextRunAt?: string;
};
type Run = {
  id: string;
  status: string;
  error?: string;
  outputs: Record<string, { url?: string; identifier?: string; title?: string } | undefined>;
};

export function Automate() {
  const [selected, setSelected] = useState(STARTERS[0]!);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();
  const [needsConnection, setNeedsConnection] = useState(false);
  const [busy, setBusy] = useState(false);
  const workflows = useApi<{ workflows: Workflow[] }>("/workflows");

  useEffect(() => {
    setError(undefined);
    setNeedsConnection(false);
    api<Preview>("/workflows/preview", {
      method: "POST",
      body: JSON.stringify({ definition: selected.definition }),
    })
      .then(setPreview)
      .catch((e: Error) => setError(e.message));
  }, [selected]);

  const manifests = useApi<{ connectors: { id: string; name: string }[] }>("/connectors");
  const nameOf = (id: string) => manifests.data?.connectors.find((m) => m.id === id)?.name ?? id;
  const connectors = connectorsUsed(selected.definition);

  async function turnOn() {
    setBusy(true);
    setError(undefined);
    setNeedsConnection(false);
    try {
      const created = await api<{ id: string; ok: boolean }>("/workflows", {
        method: "POST",
        body: JSON.stringify({ definition: selected.definition }),
      });
      await api(`/workflows/${created.id}/activate`, { method: "POST" });
    } catch (e) {
      setError((e as Error).message);
      setNeedsConnection(e instanceof ApiError && e.status === 409);
    } finally {
      setBusy(false);
      workflows.reload();
    }
  }

  return (
    <div>
      <PageHeader
        title="Automate"
        intro="Start from a familiar job or describe what should happen. You'll see exactly what it will do before anything runs."
      />

      <div className="mb-6 space-y-4">
        <AskBox
          placeholder="When someone starts a free trial, send them a welcome email"
          action="Build it"
        />
        <div className="flex flex-wrap gap-2">
          {STARTERS.map((s) => (
            <Chip key={s.label} onClick={() => setSelected(s)}>
              {s.label}
            </Chip>
          ))}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-[1fr_16rem]">
        <Card>
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="font-semibold">{selected.definition.name}</h2>
            <StatusBadge status={preview?.ok ? "needs_review" : "draft"} />
          </div>
          {preview && <SentenceView lines={preview.sentences} />}
          {preview?.issues.map((issue, i) => (
            <p key={i} className="mt-2 text-sm text-uncertain">
              {issue.message}
            </p>
          ))}
        </Card>

        <aside className="space-y-6">
          <Card>
            <h3 className="mb-2 text-sm font-semibold">Needs these apps</h3>
            <ul className="space-y-1 text-sm text-muted">
              {connectors.map((c) => (
                <li key={c}>{nameOf(c)}</li>
              ))}
            </ul>
          </Card>
          <Card>
            <h3 className="mb-2 text-sm font-semibold">Before it runs</h3>
            <p className="mb-3 text-sm text-muted">
              Check the steps on the left. Turning it on approves this version.
            </p>
            <button
              onClick={turnOn}
              disabled={busy || !preview?.ok}
              className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-50"
            >
              Review and turn on
            </button>
            {error && <p className="mt-3 text-sm text-uncertain">{error}</p>}
            {needsConnection && (
              <Link
                to="/connections"
                className="mt-1 inline-block text-sm text-accent hover:underline"
              >
                Go to Connections
              </Link>
            )}
          </Card>
        </aside>
      </div>

      <h2 className="mt-10 mb-4 text-lg font-semibold">Your automations</h2>
      {workflows.data?.workflows.length === 0 && (
        <p className="text-sm text-muted">Nothing yet. Pick a starter above and turn it on.</p>
      )}
      <div className="space-y-3">
        {workflows.data?.workflows.map((wf) => (
          <WorkflowRow key={wf.id} workflow={wf} onChange={workflows.reload} />
        ))}
      </div>
    </div>
  );
}

function WorkflowRow({ workflow, onChange }: { workflow: Workflow; onChange: () => void }) {
  const [run, setRun] = useState<Run>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const runNow = () =>
    act(async () => {
      const res = await api<{ run: Run }>(`/workflows/${workflow.id}/runs`, { method: "POST" });
      setRun(res.run);
    });
  const turnOn = () =>
    act(async () => {
      await api(`/workflows/${workflow.id}/activate`, { method: "POST" });
      onChange();
    });
  const pause = () =>
    act(async () => {
      await api(`/workflows/${workflow.id}/pause`, { method: "POST" });
      onChange();
    });

  const button =
    "rounded-lg border border-line px-3 py-1 text-sm hover:border-accent disabled:opacity-50";
  const results = Object.values(run?.outputs ?? {}).filter((o) => o?.url);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="font-medium">{workflow.name}</span>
          <StatusBadge status={workflow.status} />
        </div>
        <div className="flex gap-2">
          {workflow.status === "running" ? (
            <>
              {(workflow.trigger === "manual" || workflow.trigger === "schedule") && (
                <button onClick={runNow} disabled={busy} className={button}>
                  Run now
                </button>
              )}
              <button onClick={pause} disabled={busy} className={button}>
                Pause
              </button>
            </>
          ) : (
            <button onClick={turnOn} disabled={busy} className={button}>
              Turn on
            </button>
          )}
        </div>
      </div>
      {workflow.nextRunAt && (
        <p className="mt-2 text-sm text-muted">
          Next run{" "}
          <time dateTime={workflow.nextRunAt}>
            {new Date(workflow.nextRunAt).toLocaleString(undefined, {
              weekday: "short",
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </p>
      )}
      {error && <p className="mt-3 text-sm text-uncertain">{error}</p>}
      {run && (
        <div className="mt-3 text-sm">
          {run.status === "completed" && <p className="text-accent">Finished.</p>}
          {run.status === "failed" && (
            <p className="text-uncertain">It didn't finish: {run.error}</p>
          )}
          {run.status === "waiting" && (
            <p className="text-muted">Waiting, and will try again shortly.</p>
          )}
          {run.status === "awaiting_approval" && (
            <p className="text-muted">Waiting for your approval.</p>
          )}
          {results.map((o) => (
            <a
              key={o!.url}
              href={o!.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block text-accent hover:underline"
            >
              {o!.identifier ? `${o!.identifier}: ` : ""}
              {o!.title ?? o!.url}
            </a>
          ))}
        </div>
      )}
    </Card>
  );
}
