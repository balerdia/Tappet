import { describe, expect, it } from "vitest";
import {
  advance,
  createCatalog,
  decideApproval,
  describeWorkflowAsText,
  startRun,
  validateWorkflow,
  type ActionHandler,
  type WorkflowDefinition,
} from "./index.js";
import { advancedExample, conditionalExample, simpleExample } from "./examples.js";

const catalog = createCatalog([
  {
    connector: "webhook",
    name: "formSubmitted",
    kind: "event",
    phrase: "someone submits a contact form",
  },
  { connector: "webhook", name: "signedUp", kind: "event", phrase: "someone signs up" },
  {
    connector: "gmail",
    name: "sendEmail",
    kind: "action",
    phrase: "send an email",
    requiredInputs: ["to"],
  },
  { connector: "http", name: "request", kind: "action", phrase: "send a web request" },
  { connector: "linear", name: "searchIssues", kind: "action", phrase: "find tasks in Linear" },
  {
    connector: "drive",
    name: "deleteFile",
    kind: "action",
    phrase: "delete a file",
    sensitive: true,
  },
]);

function fakeActions(handlers: Record<string, ActionHandler>) {
  return (connector: string, action: string) => handlers[`${connector}.${action}`];
}

describe("validateWorkflow", () => {
  it("accepts the three PRD examples", () => {
    for (const def of [simpleExample, conditionalExample, advancedExample]) {
      const result = validateWorkflow(def, catalog);
      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it("rejects references to steps that haven't run yet", () => {
    const def: WorkflowDefinition = {
      ...simpleExample,
      steps: [
        {
          kind: "action",
          id: "a",
          connector: "gmail",
          action: "sendEmail",
          input: { to: { ref: "steps.b.email" } },
        },
        { kind: "action", id: "b", connector: "http", action: "request", input: {} },
      ],
    };
    const result = validateWorkflow(def, catalog);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toMatch(/hasn't happened yet/);
  });

  it("rejects loop outputs used outside the loop", () => {
    const def: WorkflowDefinition = {
      ...advancedExample,
      steps: [
        ...advancedExample.steps.slice(0, 1),
        { ...advancedExample.steps[1]!, id: "loop" } as WorkflowDefinition["steps"][number],
        {
          kind: "action",
          id: "after",
          connector: "http",
          action: "request",
          input: { x: { ref: "steps.remind" } },
        },
      ],
    };
    expect(validateWorkflow(def, catalog).ok).toBe(false);
  });

  it("requires approval before sensitive actions", () => {
    const step = {
      kind: "action",
      id: "del",
      connector: "drive",
      action: "deleteFile",
      input: {},
    } as const;
    expect(validateWorkflow({ ...simpleExample, steps: [step] }, catalog).ok).toBe(false);
    expect(
      validateWorkflow({ ...simpleExample, steps: [{ ...step, requiresApproval: true }] }, catalog)
        .ok,
    ).toBe(true);
    const withApprovalStep = validateWorkflow(
      { ...simpleExample, steps: [{ kind: "approval", id: "ok", message: "Delete it?" }, step] },
      catalog,
    );
    expect(withApprovalStep.ok).toBe(true);
  });

  it("rejects unbounded loops and unreachable steps", () => {
    const unbounded = {
      ...advancedExample,
      steps: [{ ...advancedExample.steps[1], maxItems: undefined }],
    };
    expect(validateWorkflow(unbounded).ok).toBe(false);

    const unreachable: WorkflowDefinition = {
      ...simpleExample,
      steps: [{ kind: "stop", id: "s" }, ...simpleExample.steps],
    };
    expect(validateWorkflow(unreachable).ok).toBe(false);
  });

  it("flags unknown actions and missing inputs", () => {
    const def: WorkflowDefinition = {
      ...simpleExample,
      steps: [{ kind: "action", id: "a", connector: "gmail", action: "sendEmail", input: {} }],
    };
    expect(validateWorkflow(def, catalog).issues.map((i) => i.message)).toEqual(['Missing "to".']);
  });
});

describe("describeWorkflow", () => {
  it("reads like a sentence", () => {
    expect(describeWorkflowAsText(conditionalExample, catalog)).toBe(
      [
        "When someone signs up",
        "If is new customer",
        "  Then send an email",
        "Otherwise",
        "  Then send a web request",
      ].join("\n"),
    );
    expect(describeWorkflowAsText(advancedExample, catalog)).toContain("When every day at 09:00");
    expect(describeWorkflowAsText(advancedExample, catalog)).toContain(
      "For each task in items from find overdue (up to 100)",
    );
  });
});

describe("runner", () => {
  const t0 = new Date("2026-10-26T09:00:00Z");

  it("runs a simple workflow and never repeats a finished action", async () => {
    let calls = 0;
    const deps = {
      now: () => t0,
      resolveAction: fakeActions({
        "gmail.sendEmail": async (input) => {
          calls++;
          return { sent: true, subject: input.subject };
        },
      }),
    };
    const state = startRun(simpleExample, "run_1", { name: "Sam", message: "Hi" }, t0);
    const first = await advance(simpleExample, state, deps);
    expect(first.status).toBe("completed");
    expect(first.state.journal.notify).toMatchObject({
      status: "succeeded",
      output: { subject: "New enquiry from Sam" },
    });

    const replay = await advance(simpleExample, first.state, deps);
    expect(replay.status).toBe("completed");
    expect(calls).toBe(1);
  });

  it("takes the otherwise branch", async () => {
    const seen: string[] = [];
    const deps = {
      now: () => t0,
      resolveAction: fakeActions({
        "gmail.sendEmail": async () => seen.push("email"),
        "http.request": async () => seen.push("update"),
      }),
    };
    const state = startRun(conditionalExample, "run_2", { isNewCustomer: false }, t0);
    expect((await advance(conditionalExample, state, deps)).status).toBe("completed");
    expect(seen).toEqual(["update"]);
  });

  it("loops, and stops cleanly when nothing is found", async () => {
    const sentTo: unknown[] = [];
    const tasks = [
      { title: "Brief", state_type: "started", assignee_email: "a@x.com" },
      { title: "Copy", state_type: "completed", assignee_email: "b@x.com" },
    ];
    const deps = (items: unknown[]) => ({
      now: () => t0,
      resolveAction: fakeActions({
        "linear.searchIssues": async () => ({ items }),
        "gmail.sendEmail": async (input) => sentTo.push(input.to),
      }),
    });

    const run = await advance(
      advancedExample,
      startRun(advancedExample, "r3", {}, t0),
      deps(tasks),
    );
    expect(run.status).toBe("completed");
    expect(sentTo).toEqual(["a@x.com"]);

    const empty = await advance(advancedExample, startRun(advancedExample, "r4", {}, t0), deps([]));
    expect(empty).toMatchObject({
      status: "completed",
      stopped: { reason: "Nothing is overdue today." },
    });
  });

  it("refuses to process more items than the limit", async () => {
    const deps = {
      now: () => t0,
      resolveAction: fakeActions({
        "linear.searchIssues": async () => ({ items: Array.from({ length: 101 }, () => ({})) }),
      }),
    };
    const run = await advance(advancedExample, startRun(advancedExample, "r5", {}, t0), deps);
    expect(run).toMatchObject({
      status: "failed",
      error: { message: "Found 101 items, but the limit is 100." },
    });
  });

  it("retries with backoff, then gives up", async () => {
    let now = t0;
    const deps = {
      now: () => now,
      resolveAction: fakeActions({
        "gmail.sendEmail": async () => {
          throw new Error("Gmail is down");
        },
      }),
    };
    const def: WorkflowDefinition = {
      ...simpleExample,
      steps: [
        {
          ...(simpleExample.steps[0] as Extract<
            WorkflowDefinition["steps"][number],
            { kind: "action" }
          >),
          retry: { maxAttempts: 2, backoffMs: 1000 },
        },
      ],
    };
    const first = await advance(def, startRun(def, "r6", {}, t0), deps);
    expect(first).toMatchObject({ status: "waiting", wakeAt: "2026-10-26T09:00:01.000Z" });

    // Too early: no new attempt.
    const early = await advance(def, first.state, deps);
    expect(early.status).toBe("waiting");
    expect(early.events).toEqual([]);

    now = new Date(t0.getTime() + 1000);
    const last = await advance(def, first.state, deps);
    expect(last).toMatchObject({ status: "failed", error: { message: "Gmail is down" } });
  });

  it("pauses for approval and resumes after it", async () => {
    let deleted = 0;
    const def: WorkflowDefinition = {
      ...simpleExample,
      steps: [
        {
          kind: "action",
          id: "del",
          connector: "drive",
          action: "deleteFile",
          input: {},
          requiresApproval: true,
        },
      ],
    };
    const deps = {
      now: () => t0,
      resolveAction: fakeActions({ "drive.deleteFile": async () => deleted++ }),
    };

    const pending = await advance(def, startRun(def, "r7", {}, t0), deps);
    expect(pending).toMatchObject({
      status: "awaiting_approval",
      approval: { path: "del:approval" },
    });
    expect(deleted).toBe(0);

    const approved = decideApproval(pending.state, "del:approval", "approved", "user_1");
    expect((await advance(def, approved, deps)).status).toBe("completed");
    expect(deleted).toBe(1);

    const rejected = decideApproval(pending.state, "del:approval", "rejected", "user_1");
    expect(await advance(def, rejected, deps)).toMatchObject({
      status: "completed",
      stopped: { reason: "Approval was declined." },
    });
    expect(deleted).toBe(1);
  });

  it("keeps checking on a schedule until a stop condition is met", async () => {
    let now = t0;
    let checks = 0;
    const def: WorkflowDefinition = {
      ...simpleExample,
      steps: [
        {
          kind: "repeat",
          id: "daily",
          everyMs: 24 * 3_600_000,
          maxTimes: 5,
          stopWhen: { op: "eq", left: { ref: "steps.check.done" }, right: { literal: true } },
          steps: [
            { kind: "action", id: "check", connector: "linear", action: "searchIssues", input: {} },
          ],
        },
      ],
    };
    const deps = {
      now: () => now,
      resolveAction: fakeActions({ "linear.searchIssues": async () => ({ done: ++checks >= 2 }) }),
    };

    const day1 = await advance(def, startRun(def, "r8", {}, t0), deps);
    expect(day1).toMatchObject({ status: "waiting", wakeAt: "2026-10-27T09:00:00.000Z" });

    now = new Date("2026-10-27T09:00:00Z");
    const day2 = await advance(def, day1.state, deps);
    expect(day2.status).toBe("waiting");

    now = new Date("2026-10-28T09:00:00Z");
    const day3 = await advance(def, day2.state, deps);
    expect(day3.status).toBe("completed");
    expect(checks).toBe(2);
  });
});
