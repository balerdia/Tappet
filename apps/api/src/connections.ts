import type { Hono } from "hono";
import { z } from "zod";
import { and, eq, schema } from "@tappet/db";
import {
  OAuthError,
  authorizeUrl,
  createPkcePair,
  exchangeCode,
  oauthProviders,
  revokeToken,
} from "@tappet/connectors";
import type { AppDeps, AppEnv } from "./app.js";
import { openTokens, redirectUri, sealTokens } from "./credentials.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

/** How long someone has to finish connecting before the link stops working. */
const STATE_TTL_MS = 10 * 60_000;

/**
 * Sealed into the OAuth `state` parameter. It's encrypted, so it can carry
 * the PKCE verifier without a database round trip, and it ties the callback
 * to the person and workspace that started it.
 */
type ConnectState = { w: string; u: string; c: string; exp: number; v?: string };

const CompleteBody = z.object({ code: z.string().min(1), state: z.string().min(1) });

export function registerConnectionRoutes(
  app: Hono<AppEnv>,
  deps: AppDeps,
  audit: (workspaceId: string, actorId: string, action: string, subject: string) => Promise<void>,
) {
  const { db } = deps;
  const config = deps.connect;

  const oauthFor = (connectorId: string) => {
    const manifest = deps.manifests.find((m) => m.id === connectorId);
    if (!manifest || manifest.auth.kind !== "oauth2") return { manifest };
    const provider = oauthProviders[manifest.auth.provider];
    const client = config?.clients[manifest.auth.provider];
    return { manifest, provider, client, scopes: manifest.auth.scopes };
  };

  /** Whether each app can be connected on this server right now. */
  app.get("/connectors", (c) =>
    c.json({
      connectors: deps.manifests.map((m) => ({
        ...m,
        ready: m.auth.kind === "none" || Boolean(oauthFor(m.id).client && config),
      })),
    }),
  );

  app.get("/connections", async (c) => {
    const rows = await db
      .select({
        id: schema.connections.id,
        connector: schema.connections.connector,
        label: schema.connections.label,
        status: schema.connections.status,
        scopes: schema.connections.scopes,
        createdAt: schema.connections.createdAt,
      })
      .from(schema.connections)
      .where(eq(schema.connections.workspaceId, c.get("workspaceId")));
    return c.json({ connections: rows });
  });

  /** Step 1: returns the app's sign-in page for the browser to open. */
  app.post("/connections/:connector/start", async (c) => {
    const { manifest, provider, client, scopes } = oauthFor(c.req.param("connector"));
    if (!manifest) return c.json({ error: "We don't know that app." }, 404);
    if (!provider) return c.json({ error: `${manifest.name} doesn't need connecting.` }, 400);
    if (!config || !client) {
      return c.json({ error: `${manifest.name} isn't set up on this server yet.` }, 503);
    }

    const pkce = provider.pkce ? await createPkcePair() : undefined;
    const state: ConnectState = {
      w: c.get("workspaceId"),
      u: c.get("userId"),
      c: manifest.id,
      exp: deps.now().getTime() + STATE_TTL_MS,
      v: pkce?.verifier,
    };
    const url = authorizeUrl({
      provider,
      client,
      redirectUri: redirectUri(config),
      scopes,
      state: await encryptSecret(config.credentialsKey, JSON.stringify(state)),
      codeChallenge: pkce?.challenge,
    });
    return c.json({ url });
  });

  /**
   * Step 2: the web app's callback page posts the code here. Running it as an
   * API call (rather than a browser redirect to the API) means the normal
   * sign-in check applies, and we confirm the same person started it.
   */
  app.post("/connections/complete", async (c) => {
    if (!config) return c.json({ error: "Connecting apps isn't set up on this server yet." }, 503);
    const body = CompleteBody.parse(await c.req.json());

    let state: ConnectState;
    try {
      state = JSON.parse(await decryptSecret(config.credentialsKey, body.state));
    } catch {
      return c.json({ error: "That link isn't valid. Please try connecting again." }, 400);
    }
    if (state.exp < deps.now().getTime()) {
      return c.json({ error: "That took too long. Please try connecting again." }, 400);
    }
    if (state.u !== c.get("userId") || state.w !== c.get("workspaceId")) {
      return c.json({ error: "That link was started by someone else." }, 403);
    }

    const { manifest, provider, client } = oauthFor(state.c);
    if (!manifest || !provider || !client) {
      return c.json({ error: "That app isn't set up on this server." }, 503);
    }

    let tokens;
    try {
      tokens = await exchangeCode({
        provider,
        client,
        code: body.code,
        redirectUri: redirectUri(config),
        codeVerifier: state.v,
        fetch: config.fetch,
        now: deps.now(),
      });
    } catch (err) {
      const message = err instanceof OAuthError ? err.message : "We couldn't reach the app.";
      return c.json({ error: message }, 502);
    }

    const sealed = await sealTokens(config, tokens);
    const workspaceId = c.get("workspaceId");
    // One connection per app per workspace for now; reconnecting replaces it.
    const [existing] = await db
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.workspaceId, workspaceId),
          eq(schema.connections.connector, manifest.id),
        ),
      );
    const id = existing?.id ?? deps.newId("conn");
    if (existing) {
      await db
        .update(schema.connections)
        .set({ status: "connected", encryptedCredentials: sealed, scopes: tokens.scopes })
        .where(eq(schema.connections.id, id));
    } else {
      await db.insert(schema.connections).values({
        id,
        workspaceId,
        connector: manifest.id,
        label: manifest.name,
        status: "connected",
        encryptedCredentials: sealed,
        scopes: tokens.scopes,
        createdBy: c.get("userId"),
      });
    }
    await audit(workspaceId, c.get("userId"), "connection.connected", id);
    return c.json({ id, connector: manifest.id, status: "connected" });
  });

  /** Forgets the credentials here and asks the app to revoke them too. */
  app.delete("/connections/:id", async (c) => {
    const workspaceId = c.get("workspaceId");
    const [row] = await db
      .select()
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.id, c.req.param("id")),
          eq(schema.connections.workspaceId, workspaceId),
        ),
      );
    if (!row) return c.json({ error: "Not found." }, 404);

    const { provider, client } = oauthFor(row.connector);
    if (config && provider && client && row.encryptedCredentials) {
      const tokens = await openTokens(config, row.encryptedCredentials).catch(() => undefined);
      const token = tokens?.refreshToken ?? tokens?.accessToken;
      if (token) await revokeToken({ provider, client, token, fetch: config.fetch });
    }

    await db
      .update(schema.connections)
      .set({ status: "revoked", encryptedCredentials: null })
      .where(eq(schema.connections.id, row.id));
    await audit(workspaceId, c.get("userId"), "connection.disconnected", row.id);
    return c.json({ id: row.id, status: "revoked" });
  });
}
