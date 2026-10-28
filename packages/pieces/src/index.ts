/// <reference path="./activepieces.d.ts" />
import {
  createOAuth2Client,
  googleOAuth2,
  type ConnectorManifest,
  type ConnectorRuntime,
  type OAuthClient,
} from "@tappet/connectors";
import { pieceConnector, type Piece } from "./adapter.js";
import { driveSpec, gmailSpec } from "./google.js";

export * from "./adapter.js";
export { driveSpec, gmailSpec } from "./google.js";

export type PieceEnv = { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string };

export type LoadedConnectors = {
  manifests: ConnectorManifest[];
  runtimes: ConnectorRuntime[];
  oauth: Record<string, OAuthClient>;
};

/** CommonJS pieces arrive as named exports or under `default`, depending on the loader. */
async function load(specifier: string, name: string): Promise<Piece> {
  const mod = (await import(specifier)) as Record<string, unknown> & {
    default?: Record<string, unknown>;
  };
  const piece = (mod[name] ?? mod.default?.[name]) as Piece | undefined;
  if (!piece) throw new Error(`${specifier} doesn't export "${name}".`);
  return piece;
}

/**
 * The apps Tappet runs through Activepieces. Each one connects with its
 * provider's OAuth app when that app's keys are set; without them it still
 * shows up, ready to connect once they are.
 */
export async function loadPieceConnectors(env: PieceEnv = {}): Promise<LoadedConnectors> {
  const [gmail, drive] = await Promise.all([
    load("@activepieces/piece-gmail", "gmail"),
    load("@activepieces/piece-google-drive", "googleDrive"),
  ]);
  const built = [pieceConnector(gmailSpec, gmail), pieceConnector(driveSpec, drive)];

  const oauth: Record<string, OAuthClient> = {};
  for (const b of built) {
    if (b.manifest.auth.kind !== "oauth2" || !b.oauth) continue;
    if (b.manifest.auth.provider === "google" && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
      oauth[b.manifest.id] = createOAuth2Client(
        googleOAuth2({
          ...b.oauth,
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
        }),
      );
    }
  }
  return {
    manifests: built.map((b) => b.manifest),
    runtimes: built.map((b) => b.runtime),
    oauth,
  };
}
