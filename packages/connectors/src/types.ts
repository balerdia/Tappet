import type { ActionHandler } from "@tappet/workflow";

/**
 * One connector system serves both modes. Organise uses read/search/sync;
 * Automate uses events and actions. Each connector declares what it supports
 * so the UI only offers choices that will work.
 */
export type Capability = "read" | "search" | "write" | "events" | "sync";

export type AuthSpec =
  | { kind: "oauth2"; provider: "google" | "linear" | "microsoft"; scopes: string[] }
  | { kind: "apiKey"; label: string }
  | { kind: "none" };

export type EventSpec = { name: string; phrase: string };

export type ActionSpec = {
  name: string;
  phrase: string;
  sensitive?: boolean;
  requiredInputs?: string[];
};

export type ConnectorManifest = {
  id: string;
  name: string;
  description: string;
  auth: AuthSpec;
  capabilities: Capability[];
  events: EventSpec[];
  actions: ActionSpec[];
};

/** A record retrieved from a source system, with enough provenance to cite it. */
export type SourceRecord = {
  connector: string;
  id: string;
  kind: "email" | "document" | "task" | "message" | "record";
  title: string;
  url?: string;
  text: string;
  author?: string;
  updatedAt: string;
  /** Who in the workspace may see this, as reported by the source. */
  visibleTo?: string[];
};

export type ConnectorContext = {
  /** Decrypted only for the duration of the call. Never logged. */
  credentials: Record<string, string>;
  workspaceId: string;
  /** The person on whose behalf retrieval happens, for permission-aware results. */
  actingUserId?: string;
};

export type ConnectorRuntime = {
  manifest: ConnectorManifest;
  actions?: Record<
    string,
    (
      input: Record<string, unknown>,
      ctx: ConnectorContext & Parameters<ActionHandler>[1],
    ) => Promise<unknown>
  >;
  search?: (query: string, ctx: ConnectorContext) => Promise<SourceRecord[]>;
  read?: (id: string, ctx: ConnectorContext) => Promise<SourceRecord | undefined>;
};
