import { builtInManifests, catalogFromManifests } from "@tappet/connectors";
import type { Database } from "@tappet/db";
import type { AppDeps } from "./app.js";
import { clerkAuthenticator, clerkConfigFromEnv, devAuthenticator } from "./auth.js";

/** Shared wiring for every host (Node, Docker, Workers, tests). */
export function baseDeps(db: Database, env: Record<string, string | undefined>): AppDeps {
  return {
    db,
    manifests: builtInManifests,
    catalog: catalogFromManifests(builtInManifests),
    now: () => new Date(),
    newId: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`,
    auth: authFromEnv(env),
  };
}

/** Clerk when its key is set; dev sign-in only when explicitly asked for. */
export function authFromEnv(env: Record<string, string | undefined>) {
  const clerk = clerkConfigFromEnv(env);
  if (clerk) return clerkAuthenticator(clerk);
  if (env.TAPPET_DEV_AUTH === "1") return devAuthenticator;
  return undefined;
}

export function describeAuth(env: Record<string, string | undefined>): string {
  if (clerkConfigFromEnv(env)) return "Clerk sign-in";
  if (env.TAPPET_DEV_AUTH === "1") return "dev sign-in";
  return "no sign-in configured: every request will be refused";
}
