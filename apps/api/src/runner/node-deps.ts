import { createHttpConnector } from "@tappet/connectors";
import { linearRuntime } from "@tappet/pieces";
import type { AppDeps } from "../app.js";
import type { RunnerDeps } from "./engine.js";

// Node only: this pulls in the Activepieces pieces, which must never reach
// the Workers bundle.

export function runnerDepsFrom(app: AppDeps): RunnerDeps {
  return {
    db: app.db,
    manifests: app.manifests,
    runtimes: [createHttpConnector(), linearRuntime()],
    connect: app.connect,
    now: app.now,
    newId: app.newId,
  };
}

export function runnerIntervalFromEnv(env: Record<string, string | undefined>): number {
  const ms = Number(env.RUNNER_INTERVAL_MS);
  return Number.isFinite(ms) && ms >= 1000 ? ms : 15_000;
}
