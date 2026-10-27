import { createD1Db } from "@tappet/db/d1";
import { createApp, createServices } from "./app.js";
import { baseDeps, type ServerEnv } from "./setup.js";

// Managed (Cloudflare) entry point. Static assets are served by Workers
// Assets; only /api/* reaches this handler. Secrets come from
// `wrangler secret put`.

type WorkerEnv = ServerEnv & { DB: D1Database };

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    const db = createD1Db(env.DB);
    const app = createApp(baseDeps(db, env));
    return app.fetch(request, env, ctx);
  },

  /** Cron Trigger: carry on runs whose wait or retry is over. */
  async scheduled(_controller: ScheduledController, env: WorkerEnv) {
    const db = createD1Db(env.DB);
    await createServices(baseDeps(db, env)).runs.advanceDue();
  },
} satisfies ExportedHandler<WorkerEnv>;
