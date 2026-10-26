import { createD1Db } from "@tappet/db/d1";
import { createApp } from "./app.js";
import { baseDeps } from "./setup.js";

// Managed (Cloudflare) entry point. Static assets are served by Workers
// Assets; only /api/* reaches this handler.

type WorkerEnv = {
  DB: D1Database;
  TAPPET_DEV_AUTH?: string;
  /** Set with `wrangler secret put CLERK_SECRET_KEY`. */
  CLERK_SECRET_KEY?: string;
  CLERK_AUTHORIZED_PARTIES?: string;
  /** Secrets for connecting apps; set each with `wrangler secret put`. */
  CREDENTIALS_KEY?: string;
  APP_URL?: string;
  LINEAR_CLIENT_ID?: string;
  LINEAR_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    const db = createD1Db(env.DB);
    const { DB: _db, ...vars } = env;
    const app = createApp(baseDeps(db, vars));
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;
