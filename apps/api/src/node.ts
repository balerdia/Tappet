import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createNodeDb } from "@tappet/db/node";
import { createApp } from "./app.js";
import { startRunnerLoop } from "./runner/loop.js";
import { runnerDepsFrom, runnerIntervalFromEnv } from "./runner/node-deps.js";
import { baseDeps, describeAuth } from "./setup.js";

// Self-hosted entry point: Node directly, or inside Docker.

const dbPath = resolve(process.env.DATABASE_PATH ?? "data/tappet.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });
const db = createNodeDb(dbPath);

const deps = baseDeps(db, process.env);
const server = new Hono();
server.route("/", createApp(deps));

// The runner shares this process unless it runs separately (RUNNER=0).
const runner = process.env.RUNNER !== "0";
if (runner) startRunnerLoop(runnerDepsFrom(deps), runnerIntervalFromEnv(process.env));

// Serve the built web app when it's there (Docker image, production builds).
const webDist = process.env.WEB_DIST ?? resolve(import.meta.dirname, "../../web/dist");
if (existsSync(webDist)) {
  server.use("*", serveStatic({ root: webDist }));
  server.get("*", serveStatic({ root: webDist, path: "index.html" }));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: server.fetch, port }, () => {
  console.log(
    `Tappet API on http://localhost:${port} (${describeAuth(process.env)}${runner ? ", runner on" : ""})`,
  );
});
