import { useState } from "react";
import { api } from "../api";
import { Card, PageHeader } from "../components/ui";
import { useApi } from "../useApi";

type Manifest = {
  id: string;
  name: string;
  description: string;
  auth: { kind: string };
  ready: boolean;
};
type Connection = {
  id: string;
  connector: string;
  label: string;
  status: "connected" | "needs_reauth" | "revoked";
};

const buttonClass = "rounded-lg border border-line px-3 py-1 text-sm hover:border-accent";

export function Connections() {
  const connectors = useApi<{ connectors: Manifest[] }>("/connectors");
  const connections = useApi<{ connections: Connection[] }>("/connections");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const byConnector = new Map(
    connections.data?.connections
      .filter((c) => c.status !== "revoked")
      .map((c) => [c.connector, c]),
  );

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

  async function disconnect(connection: Connection) {
    if (!window.confirm(`Disconnect ${connection.label}? Automations that use it will stop.`)) {
      return;
    }
    setBusy(connection.connector);
    setError(undefined);
    try {
      await api(`/connections/${connection.id}`, { method: "DELETE" });
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
      {(connectors.error || error) && (
        <p className="mb-4 text-uncertain">{connectors.error ?? error}</p>
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
                  {connection?.status === "needs_reauth" && (
                    <p className="mt-2 text-sm text-uncertain">
                      This connection stopped working. Reconnect to keep automations running.
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  {m.auth.kind === "none" ? (
                    <span className="text-xs text-muted">Ready</span>
                  ) : connection?.status === "connected" ? (
                    <>
                      <span className="text-xs text-accent">Connected</span>
                      <button
                        className="text-xs text-muted hover:text-ink"
                        disabled={busy === m.id}
                        onClick={() => disconnect(connection)}
                      >
                        Disconnect
                      </button>
                    </>
                  ) : m.ready ? (
                    <button
                      className={buttonClass}
                      disabled={busy === m.id}
                      onClick={() => connect(m.id)}
                    >
                      {busy === m.id
                        ? "Opening…"
                        : connection?.status === "needs_reauth"
                          ? "Reconnect"
                          : "Connect"}
                    </button>
                  ) : (
                    <span className="text-xs text-muted" title="Not set up on this server yet">
                      Coming soon
                    </span>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
