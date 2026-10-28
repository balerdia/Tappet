import { Link, useNavigate } from "react-router";
import { AskBox, Card, Chip } from "../components/ui";

const ORGANISE_STARTERS = ["What's still outstanding?", "What's overdue?", "What's due this week?"];
const AUTOMATE_STARTERS = [
  "Welcome new customers",
  "Follow up with enquiries",
  "Remind people about deadlines",
  "Keep records in sync",
  "Notify my team when something changes",
  "Send a regular report",
];

export function Home() {
  const navigate = useNavigate();
  const ask = (q: string) => navigate(`/organise?${new URLSearchParams({ q })}`);
  const describe = (q: string) => navigate(`/automate?${new URLSearchParams({ q })}`);
  return (
    <div>
      <div className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight">
          Less setting up. More getting done.
        </h1>
        <p className="mt-2 text-muted">Your apps already do plenty. We help them work together.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <h2 className="text-lg font-semibold">Organise your information</h2>
          <p className="mt-1 mb-4 text-sm text-muted">
            Make sense of what's scattered across your apps.
          </p>
          <AskBox
            placeholder="Ask about a project, customer or deadline"
            action="Ask"
            onAsk={ask}
          />
          <div className="mt-4 flex flex-wrap gap-2">
            {ORGANISE_STARTERS.map((s) => (
              <Chip key={s} onClick={() => ask(s)}>
                {s}
              </Chip>
            ))}
          </div>
          <Link to="/organise" className="mt-4 inline-block text-sm text-accent hover:underline">
            Go to Organise
          </Link>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold">Automate your work</h2>
          <p className="mt-1 mb-4 text-sm text-muted">
            Turn everyday jobs into processes that look after themselves.
          </p>
          <AskBox placeholder="Describe what should happen" action="Start" onAsk={describe} />
          <div className="mt-4 flex flex-wrap gap-2">
            {AUTOMATE_STARTERS.map((s) => (
              <Chip key={s} onClick={() => describe(s)}>
                {s}
              </Chip>
            ))}
          </div>
          <Link to="/automate" className="mt-4 inline-block text-sm text-accent hover:underline">
            Go to Automate
          </Link>
        </Card>
      </div>
    </div>
  );
}
