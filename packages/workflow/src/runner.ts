import { evaluateCondition, resolveValue, type Scope } from "./expressions.js";
import type { RetryPolicy, Step, WorkflowDefinition } from "./schema.js";

/**
 * A portable, deterministic workflow runner.
 *
 * Execution is replay-based. Each call to `advance` walks the definition from
 * the top and consults the run's journal: work already recorded there is not
 * repeated, so an action that succeeded is never called twice by the runner.
 * When the run has to wait (a delay, an approval, an external event, a retry
 * backoff) `advance` returns and the host persists the state. Calling it again
 * later carries on from where it stopped.
 *
 * The runner itself does no I/O apart from calling action handlers, so the
 * same code runs in Node, Docker and Cloudflare Workers. Hosts own storage,
 * timers and event delivery.
 *
 * Each action call receives an idempotency key that is stable across retries.
 * Whether that prevents duplicates depends on the external API honouring it;
 * the runner can't guarantee exactly-once delivery on its own.
 */

export type ActionContext = {
  idempotencyKey: string;
  attempt: number;
  runId: string;
};

export type ActionHandler = (
  input: Record<string, unknown>,
  ctx: ActionContext,
) => Promise<unknown>;

export type RunnerDeps = {
  resolveAction(connector: string, action: string): ActionHandler | undefined;
  now(): Date;
  /** Plain words for an action in run history, e.g. "send an email". */
  describeAction?(connector: string, action: string): string | undefined;
};

export type JournalEntry =
  | { type: "action"; status: "succeeded"; attempts: number; output: unknown }
  | { type: "action"; status: "retrying"; attempts: number; error: string; retryAt: string }
  | { type: "action"; status: "failed"; attempts: number; error: string }
  | { type: "wait"; wakeAt: string }
  | { type: "eventWait"; deadline: string; received?: { payload: unknown } }
  | {
      type: "approval";
      status: "pending" | "approved" | "rejected";
      requestedAt: string;
      decidedBy?: string;
    };

export type RunState = {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  trigger: unknown;
  startedAt: string;
  journal: Record<string, JournalEntry>;
};

export type RunEvent = {
  at: string;
  path: string;
  type:
    | "action.succeeded"
    | "action.retry_scheduled"
    | "action.failed"
    | "approval.requested"
    | "wait.started"
    | "loop.empty"
    | "run.completed"
    | "run.stopped"
    | "run.failed";
  message: string;
};

type Suspended =
  | {
      status: "waiting";
      wakeAt?: string;
      waitingFor?: { path: string; connector: string; event: string };
    }
  | { status: "awaiting_approval"; approval: { path: string; message: string } };

export type AdvanceResult = { state: RunState; events: RunEvent[] } & (
  | { status: "completed"; stopped?: { path: string; reason: string } }
  | Suspended
  | { status: "failed"; error: { path: string; message: string } }
);

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, backoffMs: 30_000 };

export function startRun(
  def: WorkflowDefinition,
  runId: string,
  trigger: unknown,
  now: Date,
): RunState {
  return {
    runId,
    workflowId: def.id,
    workflowVersion: def.version,
    trigger,
    startedAt: now.toISOString(),
    journal: {},
  };
}

// Control flow signals. Thrown to unwind the interpreter; caught in advance().
class Suspend {
  constructor(readonly result: Suspended) {}
}
class Stop {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {}
}
class Fail {
  constructor(
    readonly path: string,
    readonly message: string,
  ) {}
}

export async function advance(
  def: WorkflowDefinition,
  input: RunState,
  deps: RunnerDeps,
): Promise<AdvanceResult> {
  if (input.workflowId !== def.id || input.workflowVersion !== def.version) {
    throw new Error("Run state belongs to a different workflow version.");
  }

  // Run state is persisted as JSON, so cloning through JSON also keeps it honest.
  const state: RunState = JSON.parse(JSON.stringify(input));
  const events: RunEvent[] = [];
  const now = deps.now();
  const nowIso = now.toISOString();
  const emit = (path: string, type: RunEvent["type"], message: string) =>
    events.push({ at: nowIso, path, type, message });

  async function runBlock(steps: Step[], scope: Scope, prefix: string): Promise<void> {
    for (const step of steps) {
      await runStep(step, scope, prefix ? `${prefix}.${step.id}` : step.id);
    }
  }

  function approval(path: string, message: string) {
    const entry = state.journal[path];
    if (!entry) {
      state.journal[path] = { type: "approval", status: "pending", requestedAt: nowIso };
      emit(path, "approval.requested", message);
      throw new Suspend({ status: "awaiting_approval", approval: { path, message } });
    }
    if (entry.type !== "approval") throw new Fail(path, "Run history doesn't match this step.");
    if (entry.status === "pending") {
      throw new Suspend({ status: "awaiting_approval", approval: { path, message } });
    }
    if (entry.status === "rejected") throw new Stop(path, "Approval was declined.");
  }

  // The first visit records the wake-up time; later replays reuse it.
  function timedWait(path: string, wakeAt: Date) {
    let entry = state.journal[path];
    if (!entry) {
      entry = { type: "wait", wakeAt: wakeAt.toISOString() };
      state.journal[path] = entry;
      emit(path, "wait.started", `Waiting until ${entry.wakeAt}.`);
    }
    if (entry.type !== "wait") throw new Fail(path, "Run history doesn't match this step.");
    if (now < new Date(entry.wakeAt)) {
      throw new Suspend({ status: "waiting", wakeAt: entry.wakeAt });
    }
  }

  async function runStep(step: Step, scope: Scope, path: string): Promise<void> {
    switch (step.kind) {
      case "action": {
        const entry = state.journal[path];
        if (entry && entry.type !== "action") {
          throw new Fail(path, "Run history doesn't match this step.");
        }
        if (entry?.status === "succeeded") {
          scope.steps[step.id] = entry.output;
          return;
        }
        if (entry?.status === "failed") throw new Fail(path, entry.error);
        if (entry?.status === "retrying" && now < new Date(entry.retryAt)) {
          throw new Suspend({ status: "waiting", wakeAt: entry.retryAt });
        }

        if (step.requiresApproval) {
          approval(`${path}:approval`, `Approve "${step.action}" in ${step.connector}?`);
        }

        const what =
          deps.describeAction?.(step.connector, step.action) ??
          `${step.action} in ${step.connector}`;
        const handler = deps.resolveAction(step.connector, step.action);
        if (!handler) {
          throw new Fail(
            path,
            `Couldn't ${what}. Check the app is connected on the Connections screen.`,
          );
        }
        const resolvedInput = Object.fromEntries(
          Object.entries(step.input).map(([k, v]) => [k, resolveValue(scope, v)]),
        );
        const attempts = (entry?.attempts ?? 0) + 1;
        const policy = step.retry ?? DEFAULT_RETRY;

        try {
          const output = await handler(resolvedInput, {
            idempotencyKey: `${state.runId}:${path}`,
            attempt: attempts,
            runId: state.runId,
          });
          state.journal[path] = { type: "action", status: "succeeded", attempts, output };
          scope.steps[step.id] = output;
          emit(path, "action.succeeded", `Done: ${what}.`);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          if (attempts < policy.maxAttempts) {
            const delay = policy.backoffMs * 2 ** (attempts - 1);
            const retryAt = new Date(now.getTime() + delay).toISOString();
            state.journal[path] = { type: "action", status: "retrying", attempts, error, retryAt };
            emit(
              path,
              "action.retry_scheduled",
              `Couldn't ${what} (${error}). Trying again shortly.`,
            );
            throw new Suspend({ status: "waiting", wakeAt: retryAt });
          }
          state.journal[path] = { type: "action", status: "failed", attempts, error };
          emit(
            path,
            "action.failed",
            attempts > 1
              ? `Couldn't ${what} after ${attempts} tries: ${error}`
              : `Couldn't ${what}: ${error}`,
          );
          throw new Fail(path, error);
        }
        return;
      }

      case "if": {
        const branch = evaluateCondition(scope, step.condition)
          ? step.then
          : (step.otherwise ?? []);
        await runBlock(branch, scope, path);
        return;
      }

      case "forEach": {
        const items = resolveValue(scope, step.collection);
        if (!Array.isArray(items)) throw new Fail(path, "Expected a list of items here.");
        if (items.length > step.maxItems) {
          throw new Fail(path, `Found ${items.length} items, but the limit is ${step.maxItems}.`);
        }
        if (items.length === 0) {
          emit(path, "loop.empty", "Nothing was found.");
          await runBlock(step.ifEmpty ?? [], scope, `${path}:empty`);
          return;
        }
        for (const [i, item] of items.entries()) {
          const child: Scope = {
            trigger: scope.trigger,
            steps: { ...scope.steps },
            vars: { ...scope.vars, [step.as]: item },
          };
          await runBlock(step.steps, child, `${path}[${i}]`);
        }
        return;
      }

      case "repeat": {
        let previous: Scope = scope;
        for (let i = 0; i < step.maxTimes; i++) {
          if (i > 0) timedWait(`${path}#${i}:wait`, new Date(now.getTime() + step.everyMs));
          if (evaluateCondition(previous, step.stopWhen)) return;
          const round: Scope = {
            trigger: scope.trigger,
            steps: { ...scope.steps },
            vars: { ...scope.vars },
          };
          await runBlock(step.steps, round, `${path}#${i}`);
          previous = round;
        }
        return;
      }

      case "wait": {
        const until = step.until;
        if (until.kind === "duration") {
          timedWait(path, new Date(now.getTime() + until.ms));
          return;
        }
        if (until.kind === "time") {
          const at = new Date(String(resolveValue(scope, until.at)));
          if (Number.isNaN(at.getTime()))
            throw new Fail(path, "The time to wait until isn't a valid date.");
          timedWait(path, at);
          return;
        }
        let entry = state.journal[path];
        if (!entry) {
          entry = {
            type: "eventWait",
            deadline: new Date(now.getTime() + until.timeoutMs).toISOString(),
          };
          state.journal[path] = entry;
          emit(path, "wait.started", `Waiting for ${until.event} in ${until.connector}.`);
        }
        if (entry.type !== "eventWait")
          throw new Fail(path, "Run history doesn't match this step.");
        if (entry.received) {
          scope.steps[step.id] = entry.received.payload;
          return;
        }
        if (now >= new Date(entry.deadline)) return; // Timed out; carry on with no payload.
        throw new Suspend({
          status: "waiting",
          wakeAt: entry.deadline,
          waitingFor: { path, connector: until.connector, event: until.event },
        });
      }

      case "approval":
        approval(path, step.message);
        return;

      case "stop":
        throw new Stop(path, step.reason ?? "Stopped.");
    }
  }

  try {
    await runBlock(def.steps, { trigger: state.trigger, steps: {}, vars: {} }, "");
    emit("", "run.completed", "Finished.");
    return { status: "completed", state, events };
  } catch (signal) {
    if (signal instanceof Suspend) return { ...signal.result, state, events };
    if (signal instanceof Stop) {
      emit(signal.path, "run.stopped", signal.reason);
      return {
        status: "completed",
        stopped: { path: signal.path, reason: signal.reason },
        state,
        events,
      };
    }
    if (signal instanceof Fail) {
      emit(signal.path, "run.failed", signal.message);
      return {
        status: "failed",
        error: { path: signal.path, message: signal.message },
        state,
        events,
      };
    }
    throw signal;
  }
}

/** Records a person's decision on a pending approval. */
export function decideApproval(
  state: RunState,
  path: string,
  decision: "approved" | "rejected",
  decidedBy: string,
): RunState {
  const entry = state.journal[path];
  if (entry?.type !== "approval" || entry.status !== "pending") {
    throw new Error(`No pending approval at ${path}.`);
  }
  return {
    ...state,
    journal: { ...state.journal, [path]: { ...entry, status: decision, decidedBy } },
  };
}

/** Delivers an external event to a run that is waiting for one. */
export function deliverEvent(state: RunState, path: string, payload: unknown): RunState {
  const entry = state.journal[path];
  if (entry?.type !== "eventWait" || entry.received) {
    throw new Error(`Nothing is waiting for an event at ${path}.`);
  }
  return {
    ...state,
    journal: { ...state.journal, [path]: { ...entry, received: { payload } } },
  };
}
