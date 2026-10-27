import { tick, type RunnerDeps } from "./engine.js";

/**
 * Calls tick on a timer. A tick that's still going when the next one is due
 * is left to finish; ticks never overlap within one process.
 */
export function startRunnerLoop(deps: RunnerDeps, intervalMs = 15_000): () => void {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const { started, advanced } = await tick(deps);
      if (started || advanced) console.log(`runner: started ${started}, advanced ${advanced}`);
    } catch (err) {
      console.error("runner tick failed", err);
    } finally {
      busy = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
