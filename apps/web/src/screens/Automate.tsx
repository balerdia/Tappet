import { useEffect, useState } from "react";
import {
  connectorsUsed,
  examples,
  type SentenceLine,
  type ValidationIssue,
  type WorkflowDefinition,
} from "@tappet/workflow";
import { api } from "../api";
import { useApi } from "../useApi";
import { SentenceView } from "../components/SentenceView";
import { AskBox, Card, Chip, PageHeader, StatusBadge } from "../components/ui";

const STARTERS: { label: string; definition: WorkflowDefinition }[] = [
  { label: "Tell me about new enquiries", definition: examples.simpleExample },
  { label: "Welcome new customers", definition: examples.conditionalExample },
  { label: "Remind people about overdue tasks", definition: examples.advancedExample },
];

type Preview = { ok: boolean; issues: ValidationIssue[]; sentences: SentenceLine[] };

export function Automate() {
  const [selected, setSelected] = useState(STARTERS[0]!);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setError(undefined);
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
          {error && <p className="text-sm text-uncertain">{error}</p>}
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
            <p className="mb-3 text-sm text-muted">Try it with sample data, then approve it.</p>
            <button
              disabled
              className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface opacity-50"
              title="Coming soon"
            >
              Review and turn on
            </button>
          </Card>
        </aside>
      </div>
    </div>
  );
}
