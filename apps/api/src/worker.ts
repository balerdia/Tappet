import { createD1Db } from "@tappet/db/d1";
import { createApp } from "./app.js";
import { baseDeps } from "./setup.js";

// Managed (Cloudflare) entry point. Static assets are served by Workers
// Assets; only /api/* reaches this handler.

type WorkerEnv = {
  DB: D1Database;
  TAPPET_DEV_AUTH?: string;
};

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    const db = createD1Db(env.DB);
    const app = createApp(baseDeps(db, env.TAPPET_DEV_AUTH === "1"));
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;
