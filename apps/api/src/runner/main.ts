import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createNodeDb } from "@tappet/db/node";
import { baseDeps } from "../setup.js";
import { startRunnerLoop } from "./loop.js";
import { runnerDepsFrom, runnerIntervalFromEnv } from "./node-deps.js";

// Runner on its own, with no web server: for running it as a separate
// process or container. The normal Node server already runs it built in.

const dbPath = resolve(process.env.DATABASE_PATH ?? "data/tappet.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });
const deps = runnerDepsFrom(baseDeps(createNodeDb(dbPath), process.env));
const intervalMs = runnerIntervalFromEnv(process.env);

const stop = startRunnerLoop(deps, intervalMs);
console.log(`Tappet runner checking every ${intervalMs / 1000}s`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stop();
    process.exit(0);
  });
}
