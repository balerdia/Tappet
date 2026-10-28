import { useEffect, useState } from "react";
import {
  buildWorkflow,
  builderProblems,
  type BuilderSpec,
  type BuilderStep,
  type BuilderWhen,
  type SentenceLine,
} from "@tappet/workflow";
import { api } from "../api";
import { useApi } from "../useApi";
import { SentenceView } from "./SentenceView";
import { Button, Card, ErrorText } from "./ui";

type Manifest = { id: string; available: boolean };

const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const field =
  "rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-sm outline-none focus:border-accent";

/** The "Then" choices, and what a new one starts with. */
const STEP_CHOICES: { label: string; connector?: string; make: () => BuilderStep }[] = [
  {
    label: "Send an email",
    connector: "gmail",
    make: () => ({ kind: "email", to: "", subject: "", body: "" }),
  },
  {
    label: "Create a file in Google Drive",
    connector: "drive",
    make: () => ({ kind: "driveFile", name: "", text: "" }),
  },
  {
    label: "Create a task in Linear",
    connector: "linear",
    make: () => ({ kind: "linearTask", title: "" }),
  },
  { label: "Ask me first", make: () => ({ kind: "approval", message: "Go ahead?" }) },
  { label: "Wait", make: () => ({ kind: "wait", amount: 1, unit: "hours" }) },
  {
    label: "Send a web request",
    connector: "http",
    make: () => ({ kind: "webRequest", method: "POST", url: "" }),
  },
];

/**
 * Build an automation from sentences: one "When", then a list of steps.
 * What it will do is shown in plain words as you go. Saving doesn't turn
 * it on; that's a separate, reviewed step.
 */
export function SentenceBuilder({
  initialName = "",
  onSaved,
}: {
  initialName?: string;
  onSaved: (id: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [when, setWhen] = useState<BuilderWhen>({ kind: "manual" });
  const [steps, setSteps] = useState<BuilderStep[]>([]);
  const [sentences, setSentences] = useState<SentenceLine[]>([]);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const manifests = useApi<{ connectors: Manifest[] }>("/connectors");

  useEffect(() => setName(initialName), [initialName]);

  const spec: BuilderSpec = { name, when, steps };
  const problems = builderProblems(spec);
  const definition = buildWorkflow(spec);
  const draft = JSON.stringify(definition);

  // Read it back in plain words, from the same server check that saving uses.
  useEffect(() => {
    if (!JSON.parse(draft).steps.length) {
      setSentences([]);
      return;
    }
    const timer = setTimeout(() => {
      api<{ sentences: SentenceLine[] }>("/workflows/preview", {
        method: "POST",
        body: `{"definition":${draft}}`,
      })
        .then((p) => setSentences(p.sentences))
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [draft]);

  const available = (connector?: string) =>
    !connector || manifests.data?.connectors.find((m) => m.id === connector)?.available;
  const update = (i: number, next: BuilderStep) =>
    setSteps((all) => all.map((s, j) => (j === i ? next : s)));
  const remove = (i: number) => setSteps((all) => all.filter((_, j) => j !== i));

  async function save() {
    setSaving(true);
    setError(undefined);
    try {
      const { id } = await api<{ id: string }>("/workflows", {
        method: "POST",
        body: JSON.stringify({ definition }),
      });
      onSaved(id);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_16rem]">
      <Card className="space-y-5">
        <label className="block">
          <span className="mb-1 block text-sm font-semibold">Name</span>
          <input
            className={`${field} w-full`}
            value={name}
            placeholder="Weekly check-in"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div>
          <span className="mb-1 block text-sm font-semibold">When</span>
          <WhenEditor when={when} onChange={setWhen} />
        </div>

        <div>
          <span className="mb-1 block text-sm font-semibold">Then</span>
          {steps.length === 0 && (
            <p className="mb-2 text-sm text-muted">Add what should happen, in order.</p>
          )}
          <ol className="space-y-3">
            {steps.map((s, i) => (
              <li key={i} className="rounded-lg border border-line p-3">
                <div className="flex items-start justify-between gap-2">
                  <StepEditor step={s} onChange={(next) => update(i, next)} />
                  <Button tone="quiet" onClick={() => remove(i)}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex flex-wrap gap-2">
            {STEP_CHOICES.filter((c) => available(c.connector)).map((c) => (
              <Button key={c.label} onClick={() => setSteps((all) => [...all, c.make()])}>
                + {c.label}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      <aside className="space-y-6">
        <Card>
          <h3 className="mb-3 text-sm font-semibold">What it will do</h3>
          {sentences.length ? (
            <SentenceView lines={sentences} />
          ) : (
            <p className="text-sm text-muted">Add a step to see it here.</p>
          )}
        </Card>
        <Card>
          {problems.length > 0 ? (
            <ul className="mb-3 space-y-1 text-sm text-uncertain">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : (
            <p className="mb-3 text-sm text-muted">
              Saving doesn't turn it on. You'll review it first.
            </p>
          )}
          <Button tone="primary" disabled={problems.length > 0 || saving} onClick={save}>
            Save it
          </Button>
          <div className="mt-3">
            <ErrorText>{error}</ErrorText>
          </div>
        </Card>
      </aside>
    </div>
  );
}

function WhenEditor({ when, onChange }: { when: BuilderWhen; onChange: (w: BuilderWhen) => void }) {
  const time = when.kind === "manual" ? "09:00" : when.time;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <select
        aria-label="When"
        className={field}
        value={when.kind}
        onChange={(e) => {
          const kind = e.target.value as BuilderWhen["kind"];
          onChange(
            kind === "manual"
              ? { kind }
              : { kind, time, timezone: TIMEZONE, day: kind === "weekly" ? 1 : undefined },
          );
        }}
      >
        <option value="manual">I start it</option>
        <option value="daily">Every day</option>
        <option value="weekdays">Every weekday</option>
        <option value="weekly">Every week</option>
      </select>
      {when.kind === "weekly" && (
        <select
          aria-label="Day"
          className={field}
          value={when.day ?? 1}
          onChange={(e) => onChange({ ...when, day: Number(e.target.value) })}
        >
          {DAYS.map((d, i) => (
            <option key={d} value={i}>
              on {d}
            </option>
          ))}
        </select>
      )}
      {when.kind !== "manual" && (
        <>
          <span>at</span>
          <input
            aria-label="Time"
            type="time"
            className={field}
            value={when.time}
            onChange={(e) => onChange({ ...when, time: e.target.value })}
          />
          <span className="text-muted">({when.timezone.replaceAll("_", " ")} time)</span>
        </>
      )}
    </div>
  );
}

function StepEditor({ step, onChange }: { step: BuilderStep; onChange: (s: BuilderStep) => void }) {
  switch (step.kind) {
    case "email":
      return (
        <div className="flex-1 space-y-2 text-sm">
          <p className="font-medium">{step.draftOnly ? "Draft an email" : "Send an email"}</p>
          <input
            aria-label="Email to"
            className={`${field} w-full`}
            placeholder="To (separate several with commas)"
            value={step.to}
            onChange={(e) => onChange({ ...step, to: e.target.value })}
          />
          <input
            aria-label="Email subject"
            className={`${field} w-full`}
            placeholder="Subject"
            value={step.subject}
            onChange={(e) => onChange({ ...step, subject: e.target.value })}
          />
          <textarea
            aria-label="Email message"
            className={`${field} w-full`}
            placeholder="Message"
            rows={3}
            value={step.body}
            onChange={(e) => onChange({ ...step, body: e.target.value })}
          />
          <label className="flex items-center gap-2 text-muted">
            <input
              type="checkbox"
              checked={!!step.draftOnly}
              onChange={(e) => onChange({ ...step, draftOnly: e.target.checked })}
            />
            Just draft it in Gmail for me to send
          </label>
        </div>
      );
    case "driveFile":
      return (
        <div className="flex-1 space-y-2 text-sm">
          <p className="font-medium">Create a file in Google Drive</p>
          <input
            aria-label="File name"
            className={`${field} w-full`}
            placeholder="File name"
            value={step.name}
            onChange={(e) => onChange({ ...step, name: e.target.value })}
          />
          <textarea
            aria-label="File text"
            className={`${field} w-full`}
            placeholder="What goes in it"
            rows={3}
            value={step.text}
            onChange={(e) => onChange({ ...step, text: e.target.value })}
          />
        </div>
      );
    case "linearTask":
      return (
        <div className="flex-1 space-y-2 text-sm">
          <p className="font-medium">Create a task in Linear</p>
          <input
            aria-label="Task title"
            className={`${field} w-full`}
            placeholder="Task title"
            value={step.title}
            onChange={(e) => onChange({ ...step, title: e.target.value })}
          />
          <textarea
            aria-label="Task description"
            className={`${field} w-full`}
            placeholder="Description (optional)"
            rows={2}
            value={step.description ?? ""}
            onChange={(e) => onChange({ ...step, description: e.target.value })}
          />
        </div>
      );
    case "approval":
      return (
        <div className="flex-1 space-y-2 text-sm">
          <p className="font-medium">Ask me first</p>
          <input
            aria-label="Question to ask"
            className={`${field} w-full`}
            value={step.message}
            onChange={(e) => onChange({ ...step, message: e.target.value })}
          />
          <p className="text-muted">Nothing after this happens until you say yes on Activity.</p>
        </div>
      );
    case "wait":
      return (
        <div className="flex flex-1 flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Wait</span>
          <input
            aria-label="How long"
            type="number"
            min={1}
            className={`${field} w-20`}
            value={step.amount}
            onChange={(e) => onChange({ ...step, amount: Number(e.target.value) })}
          />
          <select
            aria-label="Unit"
            className={field}
            value={step.unit}
            onChange={(e) => onChange({ ...step, unit: e.target.value as typeof step.unit })}
          >
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
        </div>
      );
    case "webRequest":
      return (
        <div className="flex-1 space-y-2 text-sm">
          <p className="font-medium">Send a web request</p>
          <div className="flex gap-2">
            <select
              aria-label="Method"
              className={field}
              value={step.method}
              onChange={(e) => onChange({ ...step, method: e.target.value as "GET" | "POST" })}
            >
              <option value="POST">POST</option>
              <option value="GET">GET</option>
            </select>
            <input
              aria-label="Web address"
              className={`${field} min-w-0 flex-1`}
              placeholder="https://..."
              value={step.url}
              onChange={(e) => onChange({ ...step, url: e.target.value })}
            />
          </div>
          {step.method === "POST" && (
            <input
              aria-label="Message to send"
              className={`${field} w-full`}
              placeholder="Message to send (optional)"
              value={step.message ?? ""}
              onChange={(e) => onChange({ ...step, message: e.target.value })}
            />
          )}
        </div>
      );
  }
}
