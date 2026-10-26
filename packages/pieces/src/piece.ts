import type { ConnectorManifest, ConnectorRuntime } from "@tappet/connectors";

/** The parts of an Activepieces piece we call. */
export type Piece = {
  actions(): Record<
    string,
    { props: Record<string, { required?: boolean }>; run(context: unknown): Promise<unknown> }
  >;
};

/**
 * Maps one of our actions onto a piece action. Our input names stay our own,
 * so saved workflows don't depend on how Activepieces names things.
 */
export type ActionBinding = {
  pieceAction: string;
  /** Our input name → the piece's property name. */
  inputs: Record<string, string>;
};

/**
 * Wraps a piece as a connector runtime the workflow runner can call.
 *
 * `loadPiece` is called lazily: pieces capture `fetch` when they first load,
 * so tests install a fake before the piece is imported.
 */
export function pieceRuntime(params: {
  manifest: ConnectorManifest;
  loadPiece: () => Promise<Piece>;
  /** Turns our stored access token into the piece's auth value. */
  auth: (accessToken: string) => unknown;
  bindings: Record<string, ActionBinding>;
}): ConnectorRuntime {
  let piece: Promise<Piece> | undefined;
  const actions: NonNullable<ConnectorRuntime["actions"]> = {};

  for (const [name, binding] of Object.entries(params.bindings)) {
    actions[name] = async (input, ctx) => {
      const accessToken = ctx.credentials.accessToken;
      if (!accessToken) throw new Error(`${params.manifest.name} isn't connected.`);

      const propsValue: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input)) {
        const prop = binding.inputs[key];
        // Refuse rather than silently drop something the person asked for.
        if (!prop) throw new Error(`"${name}" in ${params.manifest.name} doesn't take "${key}".`);
        if (value !== undefined && value !== "") propsValue[prop] = value;
      }

      piece ??= params.loadPiece();
      const action = (await piece).actions()[binding.pieceAction];
      if (!action) throw new Error(`${params.manifest.name} no longer supports "${name}".`);

      // Pieces expect the Activepieces runtime around them; this is the
      // minimum they use. The store only lives for this one call.
      const store = new Map<string, unknown>();
      return action.run({
        auth: params.auth(accessToken),
        propsValue,
        store: {
          get: async (k: string) => store.get(k) ?? null,
          put: async (k: string, v: unknown) => void store.set(k, v),
          delete: async (k: string) => void store.delete(k),
        },
        files: {},
        server: {},
        run: { id: ctx.runId },
        project: { id: ctx.workspaceId },
      });
    };
  }

  return { manifest: params.manifest, actions };
}
