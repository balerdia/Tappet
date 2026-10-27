import { describe, expect, it } from "vitest";
import { createNodeDb } from "@tappet/db/node";
import { eq, schema } from "@tappet/db";
import { gmail, linear, type ConnectorRuntime } from "@tappet/connectors";
import { examples, type WorkflowDefinition } from "@tappet/workflow";
import { createApp, type AppDeps } from "../app.js";
import type { Authenticator } from "../auth.js";
import { baseDeps } from "../setup.js";
import { tick, type RunnerDeps } from "./engine.js";

const fakeAuth: Authenticator = {
  verify: async () => "alice",
  profile: async () => ({}),
};

/** A pretend Gmail that records what it was asked to send. */
function fakeGmail(behaviour: (input: Record<string, unknown>) => unknown = () => ({ id: "m1" })) {
  const sent: Record<string, unknown>[] = [];
  const runtime: ConnectorRuntime = {
    manifest: { ...gmail, auth: { kind: "none" } },
    actions: {
      sendEmail: async (input) => {
        sent.push(input);
        return behaviour(input);
      },
    },
  };
  return { sent, runtime };
}

function setup(runtimes: ConnectorRuntime[], start = "2026-10-27T08:00:00Z") {
  let now = new Date(start);
  const db = createNodeDb(":memory:");
  const app: AppDeps = { ...baseDeps(db, {}), auth: fakeAuth, now: () => now };
  const api = createApp(app);
  const runner: RunnerDeps = {
    db,
    manifests: app.manifests,
    runtimes,
    connect: {
      credentialsKey: btoa(String.fromCharCode(...new Uint8Array(32))),
      appUrl: "http://x",
      clients: {},
    },
    now: () => now,
    newId: app.newId,
  };
  const call = async (path: string, method = "GET", body?: unknown) => {
    const res = await api.request(path, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer alice" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const activate = async (definition: WorkflowDefinition) => {
    const created = await call("/api/workflows", "POST", { definition });
    expect(created.body.issues).toEqual([]);
    await call(`/api/workflows/${created.body.id}/activate`, "POST");
    return created.body.id as string;
  };
  return {
    db,
    call,
    activate,
    tick: () => tick(runner),
    at: (iso: string) => (now = new Date(iso)),
  };
}

const sendStep = {
  kind: "action",
  id: "send",
  connector: "gmail",
  action: "sendEmail",
  input: {
    to: { literal: "me@example.com" },
    subject: { literal: "Daily check" },
    body: { template: "Scheduled for {{trigger.scheduledFor}}" },
  },
} as const;

describe("runner", () => {
  it("runs a workflow started by hand and records what happened", async () => {
    const gmailFake = fakeGmail();
    const env = setup([gmailFake.runtime]);
    const id = await env.activate(examples.simpleExample);

    const started = await env.call(`/api/workflows/${id}/run`, "POST", {
      trigger: { name: "Sam", message: "Hello" },
    });
    expect(started.status).toBe(202);
    expect(await env.tick()).toEqual({ started: 0, advanced: 1 });

    expect(gmailFake.sent).toEqual([{ to: "me", subject: "New enquiry from Sam", body: "Hello" }]);
    const run = await env.call(`/api/runs/${started.body.runId}`);
    expect(run.body.run.status).toBe("completed");
    const activity = await env.call("/api/activity");
    expect(activity.body.events.map((e: { type: string }) => e.type)).toContain("run.completed");
  });

  it("won't run a workflow that isn't turned on", async () => {
    const env = setup([]);
    const created = await env.call("/api/workflows", "POST", {
      definition: examples.simpleExample,
    });
    const res = await env.call(`/api/workflows/${created.body.id}/run`, "POST");
    expect(res.status).toBe(409);
  });

  it("fires a schedule once per slot, in the workflow's time zone", async () => {
    const gmailFake = fakeGmail();
    const env = setup([gmailFake.runtime], "2026-10-27T08:00:00Z");
    await env.activate({
      ...examples.simpleExample,
      trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "Europe/London" },
      steps: [sendStep],
    });

    env.at("2026-10-27T08:59:00Z");
    expect((await env.tick()).started).toBe(0);

    env.at("2026-10-27T09:00:30Z");
    expect(await env.tick()).toEqual({ started: 1, advanced: 1 });
    expect(gmailFake.sent[0]?.body).toBe("Scheduled for 2026-10-27T09:00:00.000Z");

    env.at("2026-10-27T09:05:00Z");
    expect((await env.tick()).started).toBe(0);

    // Down for two days: only the most recent missed slot fires.
    env.at("2026-10-29T10:00:00Z");
    expect((await env.tick()).started).toBe(1);
    expect(gmailFake.sent).toHaveLength(2);
    expect(gmailFake.sent[1]?.body).toBe("Scheduled for 2026-10-29T09:00:00.000Z");
  });

  it("never does the same run twice when ticks overlap", async () => {
    const gmailFake = fakeGmail();
    const env = setup([gmailFake.runtime]);
    const id = await env.activate(examples.simpleExample);
    await env.call(`/api/workflows/${id}/run`, "POST", { trigger: { name: "A" } });

    const results = await Promise.all([env.tick(), env.tick(), env.tick()]);
    expect(results.reduce((n, r) => n + r.advanced, 0)).toBe(1);
    expect(gmailFake.sent).toHaveLength(1);
  });

  it("retries a failed action later, then carries on", async () => {
    let attempts = 0;
    const gmailFake = fakeGmail(() => {
      if (++attempts === 1) throw new Error("Gmail is busy");
      return { id: "m1" };
    });
    const env = setup([gmailFake.runtime], "2026-10-27T08:00:00Z");
    const id = await env.activate({
      ...examples.simpleExample,
      steps: [{ ...sendStep, retry: { maxAttempts: 3, backoffMs: 60_000 } }],
    });
    const { body } = await env.call(`/api/workflows/${id}/run`, "POST");

    await env.tick();
    expect((await env.call(`/api/runs/${body.runId}`)).body.run).toMatchObject({
      status: "waiting",
      wakeAt: "2026-10-27T08:01:00.000Z",
    });

    env.at("2026-10-27T08:00:30Z");
    expect((await env.tick()).advanced).toBe(0); // Not time yet.

    env.at("2026-10-27T08:01:00Z");
    await env.tick();
    expect((await env.call(`/api/runs/${body.runId}`)).body.run.status).toBe("completed");
    expect(attempts).toBe(2);
  });

  it("waits for a person to approve, then continues", async () => {
    const gmailFake = fakeGmail();
    const env = setup([gmailFake.runtime]);
    const id = await env.activate({
      ...examples.simpleExample,
      steps: [{ kind: "approval", id: "check", message: "Send the email?" }, sendStep],
    });
    const { body } = await env.call(`/api/workflows/${id}/run`, "POST");

    await env.tick();
    const waiting = await env.call(`/api/runs/${body.runId}`);
    expect(waiting.body.run.status).toBe("awaiting_approval");
    expect(waiting.body.pendingApprovals).toEqual([{ path: "check", message: "Send the email?" }]);
    const listed = await env.call("/api/runs");
    expect(listed.body.runs[0]).toMatchObject({
      id: body.runId,
      status: "awaiting_approval",
      workflowName: examples.simpleExample.name,
      pendingApprovals: [{ path: "check", message: "Send the email?" }],
    });
    expect(gmailFake.sent).toHaveLength(0);

    const approved = await env.call(`/api/runs/${body.runId}/approvals`, "POST", {
      path: "check",
      decision: "approved",
    });
    expect(approved.status).toBe(200);
    // A second answer is refused.
    expect(
      (
        await env.call(`/api/runs/${body.runId}/approvals`, "POST", {
          path: "check",
          decision: "rejected",
        })
      ).status,
    ).toBe(409);

    await env.tick();
    const done = await env.call(`/api/runs/${body.runId}`);
    expect(done.body.run.status).toBe("completed");
    expect(gmailFake.sent).toHaveLength(1);
    // The history reads in plain words, in the order things happened.
    expect(done.body.events.map((e: { message: string }) => e.message)).toEqual([
      "Send the email?",
      "Approved.",
      "Done: send an email.",
      "Finished.",
    ]);
  });

  it("flags the workflow when an app isn't connected", async () => {
    const searched: unknown[] = [];
    const linearFake: ConnectorRuntime = {
      manifest: linear, // Needs signing in.
      actions: { searchIssues: async (input) => searched.push(input) },
    };
    const env = setup([linearFake]);
    const id = await env.activate({
      ...examples.simpleExample,
      steps: [
        {
          kind: "action",
          id: "find",
          connector: "linear",
          action: "searchIssues",
          input: { query: { literal: "launch" } },
          retry: { maxAttempts: 1, backoffMs: 0 },
        },
      ],
    });
    const { body } = await env.call(`/api/workflows/${id}/run`, "POST");
    await env.tick();

    const run = await env.call(`/api/runs/${body.runId}`);
    expect(run.body.run).toMatchObject({
      status: "failed",
      error: "Linear isn't connected. Connect it on the Connections screen.",
    });
    expect(searched).toHaveLength(0);
    const [wf] = await env.db.select().from(schema.workflows).where(eq(schema.workflows.id, id));
    expect(wf?.status).toBe("needs_attention");
  });

  it("holds runs while a workflow is paused", async () => {
    const gmailFake = fakeGmail();
    const env = setup([gmailFake.runtime]);
    const id = await env.activate(examples.simpleExample);
    const { body } = await env.call(`/api/workflows/${id}/run`, "POST");
    await env.call(`/api/workflows/${id}/pause`, "POST");

    expect((await env.tick()).advanced).toBe(0);
    expect((await env.call(`/api/runs/${body.runId}`)).body.run.status).toBe("running");
    expect(gmailFake.sent).toHaveLength(0);
  });
});
