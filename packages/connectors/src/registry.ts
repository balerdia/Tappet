import {
  createCatalog,
  type ActionHandler,
  type Catalog,
  type CatalogEntry,
} from "@tappet/workflow";
import type { ConnectorContext, ConnectorManifest, ConnectorRuntime } from "./types.js";

export function catalogFromManifests(manifests: ConnectorManifest[]): Catalog {
  const entries: CatalogEntry[] = manifests.flatMap((m) => [
    ...m.events.map((e) => ({
      connector: m.id,
      name: e.name,
      kind: "event" as const,
      phrase: e.phrase,
    })),
    ...m.actions.map((a) => ({
      connector: m.id,
      name: a.name,
      kind: "action" as const,
      phrase: a.phrase,
      sensitive: a.sensitive,
      requiredInputs: a.requiredInputs,
    })),
  ]);
  return createCatalog(entries);
}

/**
 * Builds the runner's action resolver from the runtimes a workspace has
 * connected. `contextFor` supplies credentials per connector at call time.
 */
export function createActionResolver(
  runtimes: ConnectorRuntime[],
  contextFor: (connectorId: string) => ConnectorContext | undefined,
) {
  const byId = new Map(runtimes.map((r) => [r.manifest.id, r]));
  return (connector: string, action: string): ActionHandler | undefined => {
    const fn = byId.get(connector)?.actions?.[action];
    const ctx = contextFor(connector);
    if (!fn || !ctx) return undefined;
    return (input, runCtx) => fn(input, { ...ctx, ...runCtx });
  };
}
