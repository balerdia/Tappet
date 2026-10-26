import { Card, PageHeader } from "../components/ui";
import { useApi } from "../useApi";

type Manifest = { id: string; name: string; description: string; auth: { kind: string } };
type Connection = { id: string; connector: string; label: string; status: string };

export function Connections() {
  const connectors = useApi<{ connectors: Manifest[] }>("/connectors");
  const connections = useApi<{ connections: Connection[] }>("/connections");
  const connected = new Set(connections.data?.connections.map((c) => c.connector));

  return (
    <div>
      <PageHeader
        title="Connections"
        intro="The apps Tappet can use. We only ask for the access a feature needs, and you can disconnect at any time."
      />
      {connectors.error && <p className="text-uncertain">{connectors.error}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        {connectors.data?.connectors.map((m) => (
          <Card key={m.id}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold">{m.name}</h2>
                <p className="mt-1 text-sm text-muted">{m.description}</p>
              </div>
              {m.auth.kind === "none" ? (
                <span className="text-xs text-muted">Ready</span>
              ) : connected.has(m.id) ? (
                <span className="text-xs text-accent">Connected</span>
              ) : (
                <button
                  disabled
                  className="rounded-lg border border-line px-3 py-1 text-sm opacity-60"
                  title="Coming soon"
                >
                  Connect
                </button>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
