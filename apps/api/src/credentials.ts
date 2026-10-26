import { and, eq, schema, type Database } from "@tappet/db";
import {
  needsRefresh,
  oauthProviders,
  refreshTokens,
  type ConnectorManifest,
  type OAuthClient,
  type OAuthProviderId,
  type TokenSet,
} from "@tappet/connectors";
import { decryptSecret, encryptSecret } from "./secrets.js";

/** Everything needed to connect apps. Built from environment variables. */
export type ConnectConfig = {
  /** 32 random bytes, base64. Encrypts stored tokens and the OAuth state. */
  credentialsKey: string;
  /** Where the web app lives, e.g. "http://localhost:5173". */
  appUrl: string;
  clients: Partial<Record<OAuthProviderId, OAuthClient>>;
  fetch?: typeof fetch;
};

export function connectConfigFromEnv(
  env: Record<string, string | undefined>,
): ConnectConfig | undefined {
  if (!env.CREDENTIALS_KEY) return undefined;
  const clients: ConnectConfig["clients"] = {};
  for (const spec of Object.values(oauthProviders)) {
    const clientId = env[spec.env.clientId];
    const clientSecret = env[spec.env.clientSecret];
    if (clientId && clientSecret) clients[spec.id] = { clientId, clientSecret };
  }
  return {
    credentialsKey: env.CREDENTIALS_KEY,
    appUrl: (env.APP_URL ?? "http://localhost:5173").replace(/\/$/, ""),
    clients,
  };
}

/** The one address every provider sends people back to after connecting. */
export function redirectUri(config: ConnectConfig): string {
  return `${config.appUrl}/connections/callback`;
}

export function sealTokens(config: ConnectConfig, tokens: TokenSet): Promise<string> {
  return encryptSecret(config.credentialsKey, JSON.stringify(tokens));
}

export async function openTokens(config: ConnectConfig, sealed: string): Promise<TokenSet> {
  return JSON.parse(await decryptSecret(config.credentialsKey, sealed)) as TokenSet;
}

export class ConnectionNeedsAttention extends Error {}

/**
 * Returns a working access token for a workspace's connection, renewing it
 * first if it has expired. If renewal fails the connection is marked as
 * needing to be reconnected, so the person sees it on the Connections screen.
 */
export async function accessTokenFor(params: {
  db: Database;
  config: ConnectConfig;
  manifests: ConnectorManifest[];
  workspaceId: string;
  connectionId: string;
  now: Date;
}): Promise<string> {
  const { db, config } = params;
  const [row] = await db
    .select()
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.id, params.connectionId),
        eq(schema.connections.workspaceId, params.workspaceId),
      ),
    );
  if (!row || row.status !== "connected" || !row.encryptedCredentials) {
    throw new ConnectionNeedsAttention("This app needs to be connected again.");
  }

  const tokens = await openTokens(config, row.encryptedCredentials);
  if (!needsRefresh(tokens, params.now)) return tokens.accessToken;

  const manifest = params.manifests.find((m) => m.id === row.connector);
  const provider = manifest?.auth.kind === "oauth2" ? manifest.auth.provider : undefined;
  const client = provider ? config.clients[provider] : undefined;
  try {
    if (!provider || !client) throw new Error("not configured");
    const renewed = await refreshTokens({
      provider: oauthProviders[provider],
      client,
      tokens,
      fetch: config.fetch,
      now: params.now,
    });
    await db
      .update(schema.connections)
      .set({ encryptedCredentials: await sealTokens(config, renewed) })
      .where(eq(schema.connections.id, row.id));
    return renewed.accessToken;
  } catch {
    await db
      .update(schema.connections)
      .set({ status: "needs_reauth" })
      .where(eq(schema.connections.id, row.id));
    throw new ConnectionNeedsAttention(
      `${manifest?.name ?? "This app"} needs to be connected again.`,
    );
  }
}
