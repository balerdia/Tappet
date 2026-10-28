import { describe, expect, it } from "vitest";
import { createNodeDb } from "@tappet/db/node";
import { eq, schema } from "@tappet/db";
import { gmail, linear, type ConnectorRuntime } from "@tappet/connectors";
import type { WorkflowDefinition } from "@tappet/workflow";
import { createApp, createServices, type AppDeps } from "./app.js";
import type { Authenticator } from "./auth.js";
import { baseDeps } from "./setup.js";

const fakeAuth: Authenticator = {
  verify: async () => ({ subject: "sam" }),
  profile: async () => ({ email: "sam@example.com", name: "Sam" }),
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
  const deps: AppDeps = {
    ...baseDeps(db),
    auth: fakeAuth,
    runtimes,
    // Swap gmail's manifest for the fake's so activation sees no sign-in is needed.
    manifests: baseDeps(db).manifests.map(
      (m) => runtimes.find((r) => r.manifest.id === m.id)?.manifest ?? m,
    ),
    credentialsKey: btoa(String.fromCharCode(...new Uint8Array(32))),
    now: () => now,
  };
  const services = createServices(deps);
  const api = createApp(deps, services);
  const call = async (path: string, method = "GET", body?: unknown) => {
    const res = await api.request(path, {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer sam" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const activate = async (definition: WorkflowDefinition) => {
    const created = await call("/api/workflows", "POST", { definition });
    expect(created.body.issues).toEqual([]);
    const on = await call(`/api/workflows/${created.body.id}/activate`, "POST");
    expect(on.status).toBe(200);
    return created.body.id as string;
  };
  return {
    db,
    call,
    activate,
    tick: () => services.runs.tick(),
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
    body: { template: "Started {{trigger.scheduledFor}}" },
  },
} as const;

const byHand = (steps: WorkflowDefinition["steps"]): WorkflowDefinition => ({
  schemaVersion: 1,
  id: "wf",
  version: 1,
  name: "Check in",
  trigger: { kind: "manual" },
  steps,
});

const daily = (steps: WorkflowDefinition["steps"]): WorkflowDefinition => ({
  ...byHand(steps),
  trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "Europe/London" },
});

describe("runs", () => {
  it("fires a schedule once per slot, in the workflow's time zone", async () => {
    const gmailFake = fakeGmail();
    const env = setup([gmailFake.runtime], "2026-10-27T08:00:00Z");
    await env.activate(daily([sendStep]));

    env.at("2026-10-27T08:59:00Z");
    expect((await env.tick()).started).toBe(0);

    env.at("2026-10-27T09:00:30Z");
    expect((await env.tick()).started).toBe(1);
    expect(gmailFake.sent[0]?.body).toBe("Started 2026-10-27T09:00:00.000Z");

    env.at("2026-10-27T09:05:00Z");
    expect((await env.tick()).started).toBe(0);

    // Down for two days: only the most recent missed slot fires.
    env.at("2026-10-29T10:00:00Z");
    expect((await env.tick()).started).toBe(1);
    expect(gmailFake.sent).toHaveLength(2);
    expect(gmailFake.sent[1]?.body).toBe("Started 2026-10-29T09:00:00.000Z");
  });

  it("fires only the latest slot of a frequent schedule after a long outage", async () => {
    const gmailFake = fakeGmail();
    const env = setup([gmailFake.runtime], "2026-10-01T00:00:00Z");
    await env.activate({
      ...daily([sendStep]),
      trigger: { kind: "schedule", cron: "* * * * *", timezone: "UTC" },
    });

    env.at("2026-10-27T08:00:30Z"); // Over 37,000 missed minutes.
    expect((await env.tick()).started).toBe(1);
    expect(gmailFake.sent[0]?.body).toBe("Started 2026-10-27T08:00:00.000Z");
    expect((await env.tick()).started).toBe(0);
  });

  it("doesn't fire slots from before it was turned on", async () => {
    const gmailFake = fakeGmail();
    const env = setup([gmailFake.runtime], "2026-10-27T09:30:00Z");
    await env.activate(daily([sendStep]));
    expect((await env.tick()).started).toBe(0);
    expect(gmailFake.sent).toHaveLength(0);
  });

  it("retries a failed action later, then carries on", async () => {
    let attempts = 0;
    const gmailFake = fakeGmail(() => {
      if (++attempts === 1) throw new Error("Gmail is busy");
      return { id: "m1" };
    });
    const env = setup([gmailFake.runtime]);
    const id = await env.activate(
      byHand([{ ...sendStep, retry: { maxAttempts: 3, backoffMs: 60_000 } }]),
    );
    const { body } = await env.call(`/api/workflows/${id}/runs`, "POST");
    expect(body.run).toMatchObject({ status: "waiting", wakeAt: "2026-10-27T08:01:00.000Z" });

    env.at("2026-10-27T08:00:30Z");
    expect((await env.tick()).advanced).toBe(0); // Not time yet.

    env.at("2026-10-27T08:01:00Z");
    expect((await env.tick()).advanced).toBe(1);
    expect((await env.call(`/api/runs/${body.run.id}`)).body.run.status).toBe("completed");
    expect(attempts).toBe(2);
  });

  it("never does the same step twice when ticks overlap", async () => {
    let attempts = 0;
    const gmailFake = fakeGmail(() => {
      if (++attempts === 1) throw new Error("Gmail is busy");
      return { id: "m1" };
    });
    const env = setup([gmailFake.runtime]);
    const id = await env.activate(
      byHand([{ ...sendStep, retry: { maxAttempts: 3, backoffMs: 60_000 } }]),
    );
    await env.call(`/api/workflows/${id}/runs`, "POST");

    env.at("2026-10-27T08:01:00Z");
    const results = await Promise.all([env.tick(), env.tick(), env.tick()]);
    expect(results.reduce((n, r) => n + r.advanced, 0)).toBe(1);
    expect(attempts).toBe(2);
  });

  it("waits for a person to approve, then continues", async () => {
    const gmailFake = fakeGmail();
    const env = setup([gmailFake.runtime]);
    const id = await env.activate(
      byHand([{ kind: "approval", id: "check", message: "Send the email?" }, sendStep]),
    );
    const { body } = await env.call(`/api/workflows/${id}/runs`, "POST");
    expect(body.run.status).toBe("awaiting_approval");

    const waiting = await env.call(`/api/runs/${body.run.id}`);
    expect(waiting.body.pendingApprovals).toEqual([{ path: "check", message: "Send the email?" }]);
    const listed = await env.call("/api/runs");
    expect(listed.body.runs[0]).toMatchObject({
      id: body.run.id,
      status: "awaiting_approval",
      workflowName: "Check in",
      pendingApprovals: [{ path: "check", message: "Send the email?" }],
    });
    expect(gmailFake.sent).toHaveLength(0);

    const approved = await env.call(`/api/runs/${body.run.id}/approvals`, "POST", {
      path: "check",
      decision: "approved",
    });
    expect(approved.body).toMatchObject({ status: "completed" });
    // A second answer is refused.
    const again = await env.call(`/api/runs/${body.run.id}/approvals`, "POST", {
      path: "check",
      decision: "rejected",
    });
    expect(again.status).toBe(409);

    expect(gmailFake.sent).toHaveLength(1);
    // The history reads in plain words, in the order things happened.
    const done = await env.call(`/api/runs/${body.run.id}`);
    expect(done.body.events.map((e: { message: string }) => e.message)).toEqual([
      "Send the email?",
      "Approved by Sam.",
      "Done: send an email.",
      "Finished.",
    ]);
  });

  it("flags the workflow when an app's sign-in stops working", async () => {
    const created: unknown[] = [];
    const linearFake: ConnectorRuntime = {
      manifest: linear, // Needs signing in.
      actions: { createIssue: async (input) => created.push(input) },
    };
    const env = setup([linearFake]);
    // Connected once, but the stored sign-in is gone.
    const me = await env.call("/api/me");
    await env.db.insert(schema.connections).values({
      id: "conn_1",
      workspaceId: me.body.workspace.id,
      connector: "linear",
      label: "Acme",
      status: "connected",
    });
    const id = await env.activate(
      daily([
        {
          kind: "action",
          id: "task",
          connector: "linear",
          action: "createIssue",
          input: { title: { literal: "Check in" } },
        },
      ]),
    );

    env.at("2026-10-27T09:00:00Z");
    await env.tick();
    const { body } = await env.call("/api/runs");
    expect(body.runs[0]).toMatchObject({
      status: "failed",
      error:
        "Couldn't create a task in Linear. Check the app is connected on the Connections screen.",
    });
    expect(created).toHaveLength(0);
    const [wf] = await env.db.select().from(schema.workflows).where(eq(schema.workflows.id, id));
    expect(wf?.status).toBe("needs_attention");

    // Still on: it can be paused, and the next slot still fires.
    env.at("2026-10-28T09:00:00Z");
    expect((await env.tick()).started).toBe(1);
  });

  it("holds runs while a workflow is paused", async () => {
    let attempts = 0;
    const gmailFake = fakeGmail(() => {
      if (++attempts === 1) throw new Error("Gmail is busy");
      return { id: "m1" };
    });
    const env = setup([gmailFake.runtime]);
    const id = await env.activate(
      daily([{ ...sendStep, retry: { maxAttempts: 3, backoffMs: 60_000 } }]),
    );
    env.at("2026-10-27T09:00:00Z");
    await env.tick(); // Fails once, waits to retry.
    await env.call(`/api/workflows/${id}/pause`, "POST");

    env.at("2026-10-28T09:30:00Z");
    expect(await env.tick()).toEqual({ started: 0, advanced: 0 });
    expect(attempts).toBe(1);

    // Turned on again: the waiting run carries on, and old slots don't fire.
    await env.call(`/api/workflows/${id}/activate`, "POST");
    expect(await env.tick()).toEqual({ started: 0, advanced: 1 });
    expect(attempts).toBe(2);
  });
});
