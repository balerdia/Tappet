import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api";
import { AskBox, Card, Chip, Empty, ErrorText, PageHeader } from "../components/ui";
import { useApi } from "../useApi";

type Certainty = "verified" | "inferred" | "uncertain";
type Evidence = {
  connector: string;
  recordId: string;
  title: string;
  url?: string;
  excerpt: string;
};
type Finding = { id: string; summary: string; certainty: Certainty; evidence: Evidence[] };
type Source = { connector: string; name: string; status: string; found?: number };
type Answer = {
  question: string;
  summary: string;
  sources: Source[];
  findings: Finding[];
  matches: Evidence[];
};
type Manifest = { id: string; name: string; capabilities: string[]; available: boolean };
type Connection = { connector: string; status: string };

const CERTAINTY: Record<Certainty, { label: string; tone: string; text: string }> = {
  verified: {
    label: "Verified",
    tone: "bg-verified",
    text: "Stated in a source. Click through to see it.",
  },
  inferred: {
    label: "Inferred",
    tone: "bg-inferred",
    text: "A connection we made. Likely, but check if it matters.",
  },
  uncertain: {
    label: "Needs checking",
    tone: "bg-uncertain",
    text: "Possible. We need you to confirm.",
  },
};

const STARTERS = ["What's still outstanding?", "What's overdue?", "Who's working on the launch?"];

const SOURCE_STATUS: Record<string, string> = {
  searched: "Searched",
  not_connected: "Not connected",
  needs_reconnect: "Needs reconnecting",
  failed: "Couldn't reach it",
};

export function Organise() {
  const [params, setParams] = useSearchParams();
  const question = params.get("q") ?? "";
  const [answer, setAnswer] = useState<Answer>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const manifests = useApi<{ connectors: Manifest[] }>("/connectors");
  const connections = useApi<{ connections: Connection[] }>("/connections");

  // The question lives in the address, so answers can be shared and reloaded.
  useEffect(() => {
    if (!question) return;
    let live = true;
    setBusy(true);
    setError(undefined);
    api<Answer>("/organise/ask", { method: "POST", body: JSON.stringify({ question }) })
      .then((a) => live && setAnswer(a))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [question]);

  const ask = (q: string) => setParams({ q });
  const status = (id: string) => {
    const searched = answer?.sources.find((s) => s.connector === id);
    if (searched) return SOURCE_STATUS[searched.status] ?? searched.status;
    const m = manifests.data?.connectors.find((x) => x.id === id);
    if (m && !m.available) return "Coming soon";
    const c = connections.data?.connections.find((x) => x.connector === id);
    return c?.status === "connected" ? "Connected" : "Not connected";
  };
  const sources = manifests.data?.connectors.filter((m) => m.capabilities.includes("search")) ?? [];
  const anyConnected = connections.data?.connections.some((c) => c.status === "connected");

  return (
    <div>
      <PageHeader
        title="Organise"
        intro="Ask a question across your connected apps. Every answer shows where it came from. Nothing in your apps changes."
      />

      <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
        <aside className="space-y-6">
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Sources</h2>
            <ul className="space-y-2 text-sm">
              {sources.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2">
                  <span>{s.name}</span>
                  <span className="text-xs text-muted">{status(s.id)}</span>
                </li>
              ))}
            </ul>
            <Link
              to="/connections"
              className="mt-3 inline-block text-sm text-accent hover:underline"
            >
              Manage connections
            </Link>
          </Card>
          <Card>
            <h2 className="mb-3 text-sm font-semibold">How sure we are</h2>
            <ul className="space-y-3 text-sm">
              {Object.values(CERTAINTY).map((c) => (
                <li key={c.label}>
                  <span className="flex items-center gap-2 font-medium">
                    <span className={`h-2 w-2 rounded-full ${c.tone}`} />
                    {c.label}
                  </span>
                  <span className="text-muted">{c.text}</span>
                </li>
              ))}
            </ul>
          </Card>
        </aside>

        <section className="space-y-6">
          <div className="space-y-3">
            <AskBox
              placeholder="What's left to do for the launch?"
              action={busy ? "Looking..." : "Ask"}
              initial={question}
              busy={busy}
              onAsk={ask}
            />
            <div className="flex flex-wrap gap-2">
              {STARTERS.map((s) => (
                <Chip key={s} onClick={() => ask(s)}>
                  {s}
                </Chip>
              ))}
            </div>
          </div>
          <ErrorText>{error}</ErrorText>

          {!answer && !busy && (
            <Empty>
              {anyConnected
                ? "Ask about a project, a person or a deadline. Findings link back to the original tasks."
                : "Connect an app to start. Your findings, with links to the original tasks, will appear here."}
            </Empty>
          )}

          {answer && <AnswerView answer={answer} />}
        </section>
      </div>
    </div>
  );
}

function AnswerView({ answer }: { answer: Answer }) {
  const unreachable = answer.sources.filter((s) => s.status !== "searched");
  return (
    <div className="space-y-6">
      <div>
        <p className="font-medium">{answer.summary}</p>
        {unreachable.length > 0 && (
          <p className="mt-1 text-sm text-muted">
            Didn't look in{" "}
            {unreachable
              .map((s) => `${s.name} (${SOURCE_STATUS[s.status]?.toLowerCase() ?? s.status})`)
              .join(", ")}
            .
          </p>
        )}
      </div>

      {answer.findings.length > 0 && (
        <div className="space-y-3">
          {answer.findings.map((f) => (
            <Card key={f.id}>
              <p className="flex items-start gap-2">
                <span
                  className={`mt-2 h-2 w-2 shrink-0 rounded-full ${CERTAINTY[f.certainty].tone}`}
                  title={CERTAINTY[f.certainty].label}
                />
                <span>
                  {f.summary}{" "}
                  <span className="text-xs text-muted">{CERTAINTY[f.certainty].label}</span>
                </span>
              </p>
              <ul className="mt-2 space-y-1 pl-4 text-sm">
                {f.evidence.map((e) => (
                  <li key={e.recordId}>
                    <SourceLink evidence={e} />
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}

      {answer.matches.length > 0 && (
        <Card>
          <h2 className="mb-2 text-sm font-semibold">Where this came from</h2>
          <ul className="divide-y divide-line">
            {answer.matches.map((e) => (
              <li key={`${e.connector}:${e.recordId}`} className="py-2.5 text-sm">
                <SourceLink evidence={e} />
                <p className="mt-0.5 whitespace-pre-line text-muted">{e.excerpt}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function SourceLink({ evidence }: { evidence: Evidence }) {
  return evidence.url ? (
    <a
      href={evidence.url}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-accent hover:underline"
    >
      {evidence.title}
    </a>
  ) : (
    <span className="font-medium">{evidence.title}</span>
  );
}
