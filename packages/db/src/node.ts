import { fileURLToPath } from "node:url";
import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** SQLite for local development, tests and self-hosted Docker deployments. */
export function createNodeDb(path: string) {
  const sqlite = new Sqlite(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}
