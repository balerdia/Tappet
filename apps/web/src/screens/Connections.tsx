import { useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api";
import { Card, PageHeader } from "../components/ui";
import { useApi } from "../useApi";

type Manifest = {
  id: string;
  name: string;
  description: string;
  auth: { kind: string };
  connectable: boolean;
  available: boolean;
};
type Connection = { id: string; connector: string; label: string; status: string };

export function Connections() {
  const connectors = useApi<{ connectors: Manifest[] }>("/connectors");
  const connections = useApi<{ connections: Connection[] }>("/connections");
  const [params] = useSearchParams();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const byConnector = new Map(connections.data?.connections.map((c) => [c.connector, c]));

  const justConnected = connectors.data?.connectors.find((m) => m.id === params.get("connected"));
  const callbackError = params.get("error");

  async function connect(id: string) {
    setBusy(id);
    setError(undefined);
    try {
      const { url } = await api<{ url: string }>(`/connections/${id}/start`, { method: "POST" });
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(undefined);
    }
  }

  async function disconnect(id: string) {
    setBusy(id);
    setError(undefined);
    try {
      await api(`/connections/${id}`, { method: "DELETE" });
      connections.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div>
      <PageHeader
        title="Connections"
        intro="The apps Tappet can use. We only ask for the access a feature needs, and you can disconnect at any time."
      />
      {justConnected && (
        <p className="mb-4 rounded-lg bg-accent-soft px-4 py-2 text-sm text-accent">
          {justConnected.name} is connected.
        </p>
      )}
      {(callbackError || error || connectors.error) && (
        <p className="mb-4 text-sm text-uncertain">{callbackError ?? error ?? connectors.error}</p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {connectors.data?.connectors.map((m) => {
          const connection = byConnector.get(m.id);
          return (
            <Card key={m.id}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="font-semibold">{m.name}</h2>
                  <p className="mt-1 text-sm text-muted">{m.description}</p>
                  {connection && (
                    <p className="mt-2 text-xs text-muted">
                      {connection.status === "connected"
                        ? `Connected to ${connection.label}`
                        : "Needs reconnecting"}
                    </p>
                  )}
                </div>
                {m.auth.kind === "none" ? (
                  <span className="text-xs text-muted">Ready</span>
                ) : connection?.status === "connected" ? (
                  <button
                    onClick={() => disconnect(m.id)}
                    disabled={busy === m.id}
                    className="shrink-0 rounded-lg border border-line px-3 py-1 text-sm text-muted hover:text-ink disabled:opacity-50"
                  >
                    Disconnect
                  </button>
                ) : m.connectable ? (
                  <button
                    onClick={() => connect(m.id)}
                    disabled={busy === m.id}
                    className="shrink-0 rounded-lg bg-accent px-3 py-1 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-50"
                  >
                    {connection ? "Reconnect" : "Connect"}
                  </button>
                ) : (
                  <button
                    disabled
                    className="shrink-0 rounded-lg border border-line px-3 py-1 text-sm opacity-60"
                    title="Coming soon"
                  >
                    Connect
                  </button>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
