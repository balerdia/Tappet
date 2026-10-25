import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.js";

/** Cloudflare D1. Migrations are applied with `wrangler d1 migrations apply`. */
export function createD1Db(binding: Parameters<typeof drizzle>[0]) {
  return drizzle(binding, { schema });
}
