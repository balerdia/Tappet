import { AskBox, Card, Empty, PageHeader } from "../components/ui";

const SOURCES = [
  { id: "gmail", name: "Gmail" },
  { id: "drive", name: "Google Drive" },
  { id: "linear", name: "Linear" },
];

const CERTAINTY = [
  { label: "Verified", tone: "bg-verified", text: "Stated in a source. Click through to see it." },
  {
    label: "Inferred",
    tone: "bg-inferred",
    text: "A connection we made. Likely, but check if it matters.",
  },
  { label: "Needs checking", tone: "bg-uncertain", text: "Possible. We need you to confirm." },
];

export function Organise() {
  return (
    <div>
      <PageHeader
        title="Organise"
        intro="Ask a question across your connected apps. Every answer shows where it came from. Nothing in your apps changes unless you approve it."
      />

      <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
        <aside className="space-y-6">
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Sources</h2>
            <ul className="space-y-2 text-sm">
              {SOURCES.map((s) => (
                <li key={s.id} className="flex items-center justify-between">
                  <span>{s.name}</span>
                  <span className="text-xs text-muted">Not connected</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <h2 className="mb-3 text-sm font-semibold">How sure we are</h2>
            <ul className="space-y-3 text-sm">
              {CERTAINTY.map((c) => (
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
          <AskBox placeholder="What did we agree to deliver for Friday's launch?" action="Ask" />
          <Empty>
            Connect an app to start. Your findings, with links to the original emails, documents and
            tasks, will appear here.
          </Empty>
        </section>
      </div>
    </div>
  );
}
