import {
  builtInManifests,
  catalogFromManifests,
  createHttpConnector,
  createLinearConnector,
  createLinearOAuth,
  type OAuthClient,
} from "@tappet/connectors";
import { schema, type Database } from "@tappet/db";
import type { AppDeps } from "./app.js";
import { clerkAuthenticator } from "./auth.js";

export const DEV_USER = { userId: "user_dev", workspaceId: "ws_dev" };

/** The environment variables every host reads. All optional; missing ones switch features off. */
export type ServerEnv = {
  TAPPET_DEV_AUTH?: string;
  CLERK_SECRET_KEY?: string;
  /** 32 random bytes, base64. Encrypts stored connection tokens. */
  CREDENTIALS_KEY?: string;
  LINEAR_CLIENT_ID?: string;
  LINEAR_CLIENT_SECRET?: string;
  /** Where the web app lives, e.g. https://app.tappet.com. Defaults to the request's origin. */
  APP_URL?: string;
};

/**
 * "1" forces dev sign-in, "0" turns it off, and "auto" (the dev script) uses
 * it only when Clerk isn't configured.
 */
export function devAuthEnabled(env: ServerEnv) {
  if (env.TAPPET_DEV_AUTH === "1") return true;
  return env.TAPPET_DEV_AUTH === "auto" && !env.CLERK_SECRET_KEY;
}

/** Shared wiring for every host (Node, Docker, Workers, tests). */
export function baseDeps(db: Database, env: ServerEnv = {}): AppDeps {
  const oauth: Record<string, OAuthClient> = {};
  if (env.LINEAR_CLIENT_ID && env.LINEAR_CLIENT_SECRET) {
    oauth.linear = createLinearOAuth({
      clientId: env.LINEAR_CLIENT_ID,
      clientSecret: env.LINEAR_CLIENT_SECRET,
    });
  }
  return {
    db,
    manifests: builtInManifests,
    catalog: catalogFromManifests(builtInManifests),
    runtimes: [createHttpConnector(), createLinearConnector()],
    oauth,
    credentialsKey: env.CREDENTIALS_KEY,
    appUrl: env.APP_URL,
    now: () => new Date(),
    newId: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`,
    devAuth: devAuthEnabled(env) ? DEV_USER : undefined,
    auth: env.CLERK_SECRET_KEY
      ? clerkAuthenticator({
          secretKey: env.CLERK_SECRET_KEY,
          authorizedParties: env.APP_URL ? [env.APP_URL] : undefined,
        })
      : undefined,
  };
}

export async function seedDevWorkspace(db: Database) {
  await db
    .insert(schema.workspaces)
    .values({ id: DEV_USER.workspaceId, name: "My business" })
    .onConflictDoNothing();
  await db
    .insert(schema.users)
    .values({ id: DEV_USER.userId, email: "dev@localhost", name: "Developer" })
    .onConflictDoNothing();
  await db
    .insert(schema.memberships)
    .values({ workspaceId: DEV_USER.workspaceId, userId: DEV_USER.userId, role: "owner" })
    .onConflictDoNothing();
}
