import { and, eq, schema, type Database } from "@tappet/db";
import type { ConnectorContext, OAuthClient, OAuthTokens } from "@tappet/connectors";
import { decryptSecret, encryptSecret } from "./secrets.js";

// Refresh a little early so a token doesn't expire halfway through a run.
const REFRESH_MARGIN_MS = 5 * 60_000;

export type CredentialStore = {
  save(
    workspaceId: string,
    connector: string,
    label: string,
    tokens: OAuthTokens,
    userId: string,
  ): Promise<string>;
  /** Decrypted credentials for one call, refreshed first if they're about to expire. */
  contextFor(workspaceId: string, connector: string): Promise<ConnectorContext | undefined>;
  /** Raw tokens, for revoking on disconnect. */
  tokensFor(workspaceId: string, connector: string): Promise<OAuthTokens | undefined>;
};

export function createCredentialStore(deps: {
  db: Database;
  key: string;
  oauth: Record<string, OAuthClient>;
  now: () => Date;
  newId: (prefix: string) => string;
}): CredentialStore {
  const { db, key } = deps;

  async function find(workspaceId: string, connector: string) {
    const [row] = await db
      .select()
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.workspaceId, workspaceId),
          eq(schema.connections.connector, connector),
        ),
      );
    return row;
  }

  async function tokensFor(workspaceId: string, connector: string) {
    const row = await find(workspaceId, connector);
    if (!row || row.status !== "connected" || !row.encryptedCredentials) return undefined;
    return JSON.parse(await decryptSecret(key, row.encryptedCredentials)) as OAuthTokens;
  }

  return {
    async save(workspaceId, connector, label, tokens, userId) {
      const encryptedCredentials = await encryptSecret(key, JSON.stringify(tokens));
      const existing = await find(workspaceId, connector);
      if (existing) {
        await db
          .update(schema.connections)
          .set({ label, status: "connected", encryptedCredentials, scopes: tokens.scopes })
          .where(eq(schema.connections.id, existing.id));
        return existing.id;
      }
      const id = deps.newId("conn");
      await db.insert(schema.connections).values({
        id,
        workspaceId,
        connector,
        label,
        status: "connected",
        encryptedCredentials,
        scopes: tokens.scopes,
        createdBy: userId,
      });
      return id;
    },

    tokensFor,

    async contextFor(workspaceId, connector) {
      let tokens = await tokensFor(workspaceId, connector);
      if (!tokens) return undefined;

      const expiresAt = tokens.expiresAt ? new Date(tokens.expiresAt).getTime() : Infinity;
      if (expiresAt - deps.now().getTime() < REFRESH_MARGIN_MS) {
        const client = deps.oauth[connector];
        if (!client?.refresh || !tokens.refreshToken) {
          await markNeedsReauth(db, workspaceId, connector);
          return undefined;
        }
        try {
          const fresh = await client.refresh(tokens.refreshToken);
          // Some providers rotate the refresh token, others keep the old one.
          tokens = { ...fresh, refreshToken: fresh.refreshToken ?? tokens.refreshToken };
        } catch {
          await markNeedsReauth(db, workspaceId, connector);
          return undefined;
        }
        await db
          .update(schema.connections)
          .set({ encryptedCredentials: await encryptSecret(key, JSON.stringify(tokens)) })
          .where(
            and(
              eq(schema.connections.workspaceId, workspaceId),
              eq(schema.connections.connector, connector),
            ),
          );
      }

      const credentials: Record<string, string> = { accessToken: tokens.accessToken };
      return { credentials, workspaceId };
    },
  };
}

async function markNeedsReauth(db: Database, workspaceId: string, connector: string) {
  await db
    .update(schema.connections)
    .set({ status: "needs_reauth" })
    .where(
      and(
        eq(schema.connections.workspaceId, workspaceId),
        eq(schema.connections.connector, connector),
      ),
    );
}
