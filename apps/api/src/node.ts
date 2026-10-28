import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createNodeDb } from "@tappet/db/node";
import { createApp, createServices } from "./app.js";
import { baseDeps, seedDevWorkspace } from "./setup.js";

// Self-hosted entry point: Node directly, or inside Docker.

const dbPath = resolve(process.env.DATABASE_PATH ?? "data/tappet.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });
const db = createNodeDb(dbPath);

const deps = baseDeps(db, process.env);
const devAuth = Boolean(deps.devAuth);
if (devAuth) await seedDevWorkspace(db);
if (!devAuth && !deps.auth)
  console.warn("No CLERK_SECRET_KEY and dev sign-in is off: nobody can sign in.");
if (!deps.credentialsKey) console.warn("No CREDENTIALS_KEY: apps can't be connected.");

const services = createServices(deps);
const server = new Hono();
server.route("/", createApp(deps, services));

// The runner: start scheduled automations and carry on runs that are due.
// One tick at a time. RUNNER=0 turns it off, for when another host runs it.
const intervalMs = Number(process.env.RUNNER_INTERVAL_MS) || 15_000;
if (process.env.RUNNER !== "0") {
  let ticking = false;
  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      await services.runs.tick();
    } catch (err) {
      console.error("Run tick failed:", err);
    } finally {
      ticking = false;
    }
  }, intervalMs).unref();
}

// Serve the built web app when it's there (Docker image, production builds).
const webDist = process.env.WEB_DIST ?? resolve(import.meta.dirname, "../../web/dist");
if (existsSync(webDist)) {
  server.use("*", serveStatic({ root: webDist }));
  server.get("*", serveStatic({ root: webDist, path: "index.html" }));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: server.fetch, port }, () => {
  console.log(
    `Tappet API on http://localhost:${port}${devAuth ? " (dev sign-in)" : " (Clerk sign-in)"}`,
  );
});
