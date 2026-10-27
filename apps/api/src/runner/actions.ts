import { and, eq, schema } from "@tappet/db";
import type { ConnectorRuntime } from "@tappet/connectors";
import type { ActionHandler } from "@tappet/workflow";
import { accessTokenFor, ConnectionNeedsAttention } from "../credentials.js";
import type { RunnerDeps } from "./engine.js";

/**
 * Resolves a workflow's actions to connector code for one workspace. Apps
 * that need signing in get a fresh access token for that workspace's
 * connection at the moment the action runs.
 */
export function actionResolverFor(deps: RunnerDeps, workspaceId: string, now: Date) {
  const byId = new Map<string, ConnectorRuntime>(deps.runtimes.map((r) => [r.manifest.id, r]));

  return (connector: string, action: string): ActionHandler | undefined => {
    const runtime = byId.get(connector);
    const fn = runtime?.actions?.[action];
    if (!runtime || !fn) return undefined;

    return async (input, runCtx) => {
      let credentials: Record<string, string> = {};
      if (runtime.manifest.auth.kind === "oauth2") {
        if (!deps.connect) {
          throw new ConnectionNeedsAttention("Connecting apps isn't set up on this server.");
        }
        const [connection] = await deps.db
          .select({ id: schema.connections.id })
          .from(schema.connections)
          .where(
            and(
              eq(schema.connections.workspaceId, workspaceId),
              eq(schema.connections.connector, connector),
              eq(schema.connections.status, "connected"),
            ),
          );
        if (!connection) {
          throw new ConnectionNeedsAttention(
            `${runtime.manifest.name} isn't connected. Connect it on the Connections screen.`,
          );
        }
        const accessToken = await accessTokenFor({
          db: deps.db,
          config: deps.connect,
          manifests: deps.manifests,
          workspaceId,
          connectionId: connection.id,
          now,
        });
        credentials = { accessToken };
      }
      return fn(input, { ...runCtx, credentials, workspaceId });
    };
  };
}
