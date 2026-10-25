import { builtInManifests, catalogFromManifests } from "@tappet/connectors";
import { schema, type Database } from "@tappet/db";
import type { AppDeps } from "./app.js";

export const DEV_USER = { userId: "user_dev", workspaceId: "ws_dev" };

/** Shared wiring for every host (Node, Docker, Workers, tests). */
export function baseDeps(db: Database, devAuth: boolean): AppDeps {
  return {
    db,
    manifests: builtInManifests,
    catalog: catalogFromManifests(builtInManifests),
    now: () => new Date(),
    newId: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`,
    devAuth: devAuth ? DEV_USER : undefined,
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
