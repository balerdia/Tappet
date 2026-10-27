import { useState } from "react";
import {
  connectorsUsed,
  type SentenceLine,
  type ValidationIssue,
  type WorkflowDefinition,
  type WorkflowStatus,
} from "@tappet/workflow";
import { api } from "../api";
import { useApi } from "../useApi";
import { RunList } from "./RunList";
import { SentenceView } from "./SentenceView";
import { Button, Card, ErrorText, StatusBadge } from "./ui";

type Detail = {
  workflow: { id: string; name: string; status: WorkflowStatus; activeVersion: number | null };
  definition: WorkflowDefinition;
  ok: boolean;
  issues: ValidationIssue[];
  sentences: SentenceLine[];
};
type Manifest = { id: string; name: string; auth: { kind: string } };
type Connection = { connector: string; status: string };

/**
 * One saved automation: what it does, what it needs, and the controls to
 * turn it on, pause it or run it now. Turning on always shows exactly what
 * will run and asks first.
 */
export function WorkflowPanel({ id, onChanged }: { id: string; onChanged: () => void }) {
  const detail = useApi<Detail>(`/workflows/${id}`);
  const manifests = useApi<{ connectors: Manifest[] }>("/connectors");
  const connections = useApi<{ connections: Connection[] }>("/connections");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  if (detail.error) return <ErrorText>{detail.error}</ErrorText>;
  if (!detail.data) return null;
  const { workflow, definition, ok, issues, sentences } = detail.data;

  const connected = new Set(
    connections.data?.connections.filter((c) => c.status === "connected").map((c) => c.connector),
  );
  const needs = connectorsUsed(definition).map((cid) => {
    const m = manifests.data?.connectors.find((x) => x.id === cid);
    return {
      id: cid,
      name: m?.name ?? cid,
      ready: !m || m.auth.kind === "none" || connected.has(cid),
    };
  });
  const missing = needs.filter((n) => !n.ready);

  async function act(path: string, done: string) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await api(`/workflows/${id}/${path}`, { method: "POST" });
      setNotice(done);
      setConfirming(false);
      detail.reload();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const on = workflow.status === "running" || workflow.status === "needs_attention";
  const canTurnOn =
    ok && ["needs_review", "ready", "paused"].includes(workflow.status) && missing.length === 0;

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_16rem]">
      <div className="space-y-6">
        <Card>
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="font-semibold">{workflow.name}</h2>
            <StatusBadge status={workflow.status} />
          </div>
          <SentenceView lines={sentences} />
          {issues.map((issue, i) => (
            <p key={i} className="mt-2 text-sm text-uncertain">
              {issue.message}
            </p>
          ))}
        </Card>

        <Card>
          <h3 className="mb-2 text-sm font-semibold">Recent runs</h3>
          <RunList workflowId={id} showName={false} />
        </Card>
      </div>

      <aside className="space-y-6">
        <Card>
          <h3 className="mb-2 text-sm font-semibold">Needs these apps</h3>
          <ul className="space-y-1 text-sm">
            {needs.map((n) => (
              <li key={n.id} className="flex justify-between gap-2">
                <span>{n.name}</span>
                <span className={n.ready ? "text-muted" : "text-uncertain"}>
                  {n.ready ? "Ready" : "Not connected"}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          {on ? (
            <div className="space-y-3">
              <p className="text-sm text-muted">
                {workflow.status === "needs_attention"
                  ? "A recent run didn't finish. It's still on; check the run below to see why."
                  : "This is on and will run by itself."}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  tone="primary"
                  disabled={busy}
                  onClick={() => act("run", "Started. It'll appear under Recent runs in a moment.")}
                >
                  Run now
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    act("pause", "Paused. Nothing will run until you turn it on again.")
                  }
                >
                  Pause
                </Button>
              </div>
            </div>
          ) : confirming ? (
            <div className="space-y-3">
              <p className="text-sm font-medium">When it's on, this will:</p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                {sentences.map((s, i) => (
                  <li key={i}>
                    {s.phrase} {s.text}
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button tone="primary" disabled={busy} onClick={() => act("activate", "It's on.")}>
                  Turn it on
                </Button>
                <Button tone="quiet" disabled={busy} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted">
                {!ok
                  ? "Fix the problems shown before this can be turned on."
                  : missing.length
                    ? `Connect ${missing.map((m) => m.name).join(" and ")} first.`
                    : workflow.status === "paused"
                      ? "Paused. Turn it on to start running again."
                      : "Check what it will do, then turn it on."}
              </p>
              <Button
                tone="primary"
                disabled={!canTurnOn || busy}
                onClick={() => setConfirming(true)}
              >
                {workflow.status === "paused" ? "Turn on again" : "Review and turn on"}
              </Button>
            </div>
          )}
          {notice && <p className="mt-3 text-sm text-accent">{notice}</p>}
          <div className="mt-3">
            <ErrorText>{error}</ErrorText>
          </div>
        </Card>
      </aside>
    </div>
  );
}
