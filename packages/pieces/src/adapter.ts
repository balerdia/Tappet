import type {
  ActionSpec,
  Capability,
  ConnectorContext,
  ConnectorManifest,
  ConnectorRuntime,
  SourceRecord,
} from "@tappet/connectors";

/** The parts of an Activepieces piece we use. */
export type Piece = {
  displayName: string;
  description?: string;
  auth?: unknown;
  actions(): Record<string, PieceAction>;
};

export type PieceAction = {
  displayName: string;
  props: Record<string, { required?: boolean; defaultValue?: unknown }>;
  run(context: unknown): Promise<unknown>;
};

export type PieceOAuth = { authUrl: string; tokenUrl: string; scopes: string[] };

/**
 * One of our actions on top of a piece action. Our names and inputs stay our
 * own, so saved workflows don't break when Activepieces renames something.
 */
export type ActionBinding = {
  pieceAction: string;
  phrase: string;
  sensitive?: boolean;
  /** Our input name → the piece property it fills, with an optional conversion. */
  inputs: Record<string, string | { prop: string; convert: (value: unknown) => unknown }>;
  required?: string[];
  /** Piece properties we always set, such as "plain text" for an email body. */
  fixed?: Record<string, unknown>;
  /** Keeps what we store small and free of anything sensitive. */
  output?: (result: unknown) => unknown;
};

export type PieceConnectorSpec = {
  id: string;
  /** Who runs the sign-in. Connectors sharing one can share an OAuth app. */
  provider: "google" | "microsoft" | "linear";
  /** Defaults to the piece's own name and description. */
  name?: string;
  description?: string;
  capabilities: Capability[];
  actions: Record<string, ActionBinding>;
  /** For Organise: find records matching some words, using the piece's actions. */
  search?: (
    query: string,
    run: (action: string, input: Record<string, unknown>) => Promise<unknown>,
  ) => Promise<SourceRecord[]>;
};

/** The piece's OAuth 2 sign-in details, if it uses OAuth 2. */
export function pieceOAuth(piece: Piece): PieceOAuth | undefined {
  const options = Array.isArray(piece.auth) ? piece.auth : [piece.auth];
  const oauth = options.find(
    (a): a is { type: string; authUrl: string; tokenUrl: string; scope: string[] } =>
      !!a && typeof a === "object" && (a as { type?: string }).type === "OAUTH2",
  );
  return oauth && { authUrl: oauth.authUrl, tokenUrl: oauth.tokenUrl, scopes: oauth.scope };
}

/**
 * HTTP clients inside pieces return their whole response, including request
 * settings. Keep only the data.
 */
export function plainResult(result: unknown): unknown {
  if (result && typeof result === "object" && "config" in result && "data" in result) {
    return (result as { data: unknown }).data;
  }
  return result;
}

/** Turns a piece into a Tappet connector: a manifest for the builder and a runtime for the runner. */
export function pieceConnector(
  spec: PieceConnectorSpec,
  piece: Piece,
): { manifest: ConnectorManifest; runtime: ConnectorRuntime; oauth?: PieceOAuth } {
  const oauth = pieceOAuth(piece);
  const name = spec.name ?? piece.displayName;
  const pieceActions = piece.actions();

  const actions: ActionSpec[] = Object.entries(spec.actions).map(([actionName, b]) => {
    if (!pieceActions[b.pieceAction]) {
      throw new Error(`${name} has no "${b.pieceAction}" action. Check the piece version.`);
    }
    return {
      name: actionName,
      phrase: b.phrase,
      sensitive: b.sensitive,
      requiredInputs: b.required,
    };
  });

  const manifest: ConnectorManifest = {
    id: spec.id,
    name,
    description: spec.description ?? piece.description ?? "",
    auth: oauth
      ? { kind: "oauth2", provider: spec.provider, scopes: oauth.scopes }
      : { kind: "apiKey", label: `${name} key` },
    capabilities: spec.capabilities,
    events: [],
    actions,
  };

  async function run(
    actionName: string,
    input: Record<string, unknown>,
    ctx: ConnectorContext & { runId?: string },
  ) {
    const binding = spec.actions[actionName];
    if (!binding) throw new Error(`${name} can't "${actionName}".`);
    const accessToken = ctx.credentials.accessToken;
    if (!accessToken) throw new Error(`${name} isn't connected.`);
    const action = pieceActions[binding.pieceAction]!;

    const propsValue: Record<string, unknown> = {};
    for (const [prop, def] of Object.entries(action.props)) {
      if (def.defaultValue !== undefined) propsValue[prop] = def.defaultValue;
    }
    Object.assign(propsValue, binding.fixed);
    for (const [key, value] of Object.entries(input)) {
      const target = binding.inputs[key];
      // Refuse rather than silently drop something the person asked for.
      if (!target) throw new Error(`"${actionName}" in ${name} doesn't take "${key}".`);
      if (value === undefined || value === "") continue;
      if (typeof target === "string") propsValue[target] = value;
      else propsValue[target.prop] = target.convert(value);
    }

    // Pieces expect the Activepieces runtime around them; this is the minimum
    // they use. The store and files only live for this one call.
    const store = new Map<string, unknown>();
    const result = await action
      .run({
        auth: { type: "OAUTH2", access_token: accessToken, data: {} },
        propsValue,
        store: {
          get: async (k: string) => store.get(k) ?? null,
          put: async (k: string, v: unknown) => void store.set(k, v),
          delete: async (k: string) => void store.delete(k),
        },
        files: { write: async ({ fileName }: { fileName: string }) => `attachment:${fileName}` },
        server: { apiUrl: "", publicUrl: "", token: "" },
        run: { id: ctx.runId ?? "organise" },
        project: { id: ctx.workspaceId },
      })
      .catch((err: unknown) => {
        throw new Error(safeMessage(err, accessToken));
      });
    const plain = plainResult(result);
    return binding.output ? binding.output(plain) : plain;
  }

  const runtime: ConnectorRuntime = {
    manifest,
    actions: Object.fromEntries(
      Object.keys(spec.actions).map((a) => [a, (input, ctx) => run(a, input, ctx)]),
    ),
    search: spec.search
      ? (query, ctx) => spec.search!(query, (action, input) => run(action, input, ctx))
      : undefined,
  };

  return { manifest, runtime, oauth };
}

/**
 * Piece errors can quote the request they made, headers and all. Run history
 * is shown to people and kept, so never let a token into it.
 */
export function safeMessage(err: unknown, accessToken: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const clean = message
    .split(accessToken)
    .join("[hidden]")
    .replace(/(bearer|authorization"?:?\s*"?)\s*[\w.~+/=-]{8,}/gi, "$1 [hidden]")
    .split("\n")[0]!
    .trim();
  return clean.length > 300 ? `${clean.slice(0, 297)}...` : clean || "Something went wrong.";
}

/** "a, b; c" → ["a", "b", "c"]. For fields that take several email addresses. */
export const addressList = (value: unknown) =>
  (Array.isArray(value) ? value : String(value).split(/[,;]/))
    .map((v) => String(v).trim())
    .filter(Boolean);
