import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema.js";

export { schema };
// Re-exported so callers share one drizzle-orm instance.
export { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
export * from "./schema.js";

/**
 * The database type the rest of the app codes against. Both the D1 driver and
 * the better-sqlite3 driver satisfy it; the "async" mode means callers always
 * await, which works with either.
 */
export type Database = BaseSQLiteDatabase<"async" | "sync", unknown, typeof schema>;
