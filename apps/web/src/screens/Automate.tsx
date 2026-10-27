import { useEffect, useState } from "react";
import {
  connectorsUsed,
  examples,
  type SentenceLine,
  type ValidationIssue,
  type WorkflowDefinition,
  type WorkflowStatus,
} from "@tappet/workflow";
import { api } from "../api";
import { useApi } from "../useApi";
import { SentenceView } from "../components/SentenceView";
import { WorkflowPanel } from "../components/WorkflowPanel";
import {
  AskBox,
  Button,
  Card,
  Chip,
  Empty,
  ErrorText,
  PageHeader,
  StatusBadge,
} from "../components/ui";

const STARTERS: { label: string; definition: WorkflowDefinition }[] = [
  { label: "Add a task to Linear", definition: examples.linearTaskExample },
  { label: "Tell me about new enquiries", definition: examples.simpleExample },
  { label: "Welcome new customers", definition: examples.conditionalExample },
  { label: "Remind people about overdue tasks", definition: examples.advancedExample },
];

type Preview = { ok: boolean; issues: ValidationIssue[]; sentences: SentenceLine[] };
type WorkflowRow = { id: string; name: string; status: WorkflowStatus };
type Selection = { kind: "saved"; id: string } | { kind: "starter"; index: number };

export function Automate() {
  const workflows = useApi<{ workflows: WorkflowRow[] }>("/workflows");
  const [selection, setSelection] = useState<Selection>();

  // Show the first saved automation, or the first starter if there are none.
  useEffect(() => {
    if (selection || !workflows.data) return;
    const first = workflows.data.workflows[0];
    setSelection(first ? { kind: "saved", id: first.id } : { kind: "starter", index: 0 });
  }, [selection, workflows.data]);

  return (
    <div>
      <PageHeader
        title="Automate"
        intro="Start from a familiar job or describe what should happen. You'll see exactly what it will do before anything runs."
      />

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold">Your automations</h2>
        <ErrorText>{workflows.error}</ErrorText>
        {workflows.data?.workflows.length === 0 ? (
          <Empty>Nothing yet. Pick a starter below and save it to try it out.</Empty>
        ) : (
          <div className="flex flex-wrap gap-2">
            {workflows.data?.workflows.map((w) => {
              const active = selection?.kind === "saved" && selection.id === w.id;
              return (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => setSelection({ kind: "saved", id: w.id })}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                    active
                      ? "border-accent bg-accent-soft"
                      : "border-line bg-surface hover:border-accent"
                  }`}
                >
                  {w.name}
                  <StatusBadge status={w.status} />
                </button>
              );
            })}
          </div>
        )}
      </section>

      {selection?.kind === "saved" && (
        <section className="mb-10">
          <WorkflowPanel key={selection.id} id={selection.id} onChanged={workflows.reload} />
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold">Start something new</h2>
        <div className="mb-6 space-y-4">
          <AskBox
            placeholder="When someone starts a free trial, send them a welcome email"
            action="Build it"
          />
          <div className="flex flex-wrap gap-2">
            {STARTERS.map((s, index) => (
              <Chip key={s.label} onClick={() => setSelection({ kind: "starter", index })}>
                {s.label}
              </Chip>
            ))}
          </div>
        </div>
        {selection?.kind === "starter" && (
          <StarterPreview
            starter={STARTERS[selection.index]!}
            onSaved={(id) => {
              workflows.reload();
              setSelection({ kind: "saved", id });
            }}
          />
        )}
      </section>
    </div>
  );
}

function StarterPreview({
  starter,
  onSaved,
}: {
  starter: (typeof STARTERS)[number];
  onSaved: (id: string) => void;
}) {
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const manifests = useApi<{ connectors: { id: string; name: string }[] }>("/connectors");
  const nameOf = (id: string) => manifests.data?.connectors.find((m) => m.id === id)?.name ?? id;

  useEffect(() => {
    setError(undefined);
    api<Preview>("/workflows/preview", {
      method: "POST",
      body: JSON.stringify({ definition: starter.definition }),
    })
      .then(setPreview)
      .catch((e: Error) => setError(e.message));
  }, [starter]);

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      const { id } = await api<{ id: string }>("/workflows", {
        method: "POST",
        body: JSON.stringify({ definition: starter.definition }),
      });
      onSaved(id);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_16rem]">
      <Card>
        <h3 className="mb-4 font-semibold">{starter.definition.name}</h3>
        <ErrorText>{error}</ErrorText>
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
            {connectorsUsed(starter.definition).map((c) => (
              <li key={c}>{nameOf(c)}</li>
            ))}
          </ul>
        </Card>
        <Card>
          <p className="mb-3 text-sm text-muted">
            Saving it doesn't turn it on. You'll review it first.
          </p>
          <Button tone="primary" disabled={saving} onClick={save}>
            Use this one
          </Button>
        </Card>
      </aside>
    </div>
  );
}
