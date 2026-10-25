import { Card, Empty, PageHeader } from "../components/ui";
import { useApi } from "../useApi";

type RunEvent = { id: number; runId: string; at: string; type: string; message: string };

export function Activity() {
  const { data, error, loading } = useApi<{ events: RunEvent[] }>("/activity");

  return (
    <div>
      <PageHeader
        title="Activity"
        intro="Everything your automations have done, and anything that needs you."
      />
      {error && <p className="text-uncertain">{error}</p>}
      {!loading && !error && data?.events.length === 0 && <Empty>Nothing has run yet.</Empty>}
      {data && data.events.length > 0 && (
        <Card>
          <ul className="divide-y divide-line">
            {data.events.map((e) => (
              <li key={e.id} className="flex justify-between gap-4 py-2 text-sm">
                <span>{e.message}</span>
                <time className="shrink-0 text-muted" dateTime={e.at}>
                  {new Date(e.at).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
