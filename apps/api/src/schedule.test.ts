import { beforeEach, describe, expect, it } from "vitest";
import { createLinearConnector } from "@tappet/connectors";
import { createNodeDb } from "@tappet/db/node";
import { schema } from "@tappet/db";
import { examples } from "@tappet/workflow";
import { createApp, createServices, type AppDeps } from "./app.js";
import { tick } from "./runs.js";
import { baseDeps, seedDevWorkspace } from "./setup.js";

// Scheduled automations, with the clock under the test's control.
// The example runs at 09:00 London time on weekdays. 27 Oct 2026 is a
// Tuesday, after the clocks went back, so London is on UTC.

describe("schedules", () => {
  let clock: Date;
  let deps: AppDeps;
  let app: ReturnType<typeof createApp>;
  let services: ReturnType<typeof createServices>;
  let created: string[];

  beforeEach(async () => {
    clock = new Date("2026-10-27T08:00:00Z");
    created = [];
    const db = createNodeDb(":memory:");
    await seedDevWorkspace(db);
    const fakeLinear = (async (_url: URL | string, init?: RequestInit) => {
      const { query, variables } = JSON.parse(String(init?.body));
      if (query.includes("teams"))
        return Response.json({ data: { teams: { nodes: [{ id: "t" }] } } });
      created.push(variables.input.title);
      const issue = {
        id: "i",
        identifier: `ENG-${created.length}`,
        title: variables.input.title,
        url: "u",
      };
      return Response.json({ data: { issueCreate: { success: true, issue } } });
    }) as typeof fetch;
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    deps = {
      ...baseDeps(db, { TAPPET_DEV_AUTH: "1", CREDENTIALS_KEY: key }),
      now: () => clock,
      runtimes: [createLinearConnector(fakeLinear)],
    };
    services = createServices(deps);
    app = createApp(deps, services);
    await services.credentials!.save(
      "ws_dev",
      "linear",
      "Acme",
      { accessToken: "tok", scopes: ["read", "write"] },
      "user_dev",
    );
  });

  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function turnOn(definition = examples.linearScheduledExample) {
    const { id } = await (await post("/api/workflows", { definition })).json();
    expect((await post(`/api/workflows/${id}/activate`)).status).toBe(200);
    return id as string;
  }

  const runCount = async () => (await deps.db.select().from(schema.runs)).length;

  it("runs once when the time comes, however many ticks there are", async () => {
    await turnOn();
    await tick(services.runs);
    expect(created).toHaveLength(0);

    clock = new Date("2026-10-27T09:00:20Z");
    await tick(services.runs);
    await tick(services.runs);
    clock = new Date("2026-10-27T09:05:00Z");
    await Promise.all([tick(services.runs), tick(services.runs)]);
    expect(created).toEqual(["Follow up with new customers"]);
    expect(await runCount()).toBe(1);

    const [run] = await deps.db.select().from(schema.runs);
    expect(run).toMatchObject({
      status: "completed",
      triggerKey: "schedule:2026-10-27T09:00:00.000Z",
    });

    // And again the next weekday.
    clock = new Date("2026-10-28T09:00:30Z");
    await tick(services.runs);
    expect(created).toHaveLength(2);
  });

  it("doesn't fire a time from before it was turned on", async () => {
    clock = new Date("2026-10-27T09:10:00Z");
    await turnOn();
    await tick(services.runs);
    expect(await runCount()).toBe(0);
  });

  it("catches up a recently missed time but not a stale one", async () => {
    await turnOn();
    clock = new Date("2026-10-27T09:45:00Z");
    await tick(services.runs);
    expect(await runCount()).toBe(1);

    clock = new Date("2026-10-28T11:00:00Z");
    await tick(services.runs);
    expect(await runCount()).toBe(1);
  });

  it("stops while paused", async () => {
    const id = await turnOn();
    await post(`/api/workflows/${id}/pause`);
    clock = new Date("2026-10-27T09:00:20Z");
    await tick(services.runs);
    expect(await runCount()).toBe(0);
  });

  it("reads the time in the automation's timezone", async () => {
    await turnOn({
      ...examples.linearScheduledExample,
      trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "America/New_York" },
    });
    clock = new Date("2026-10-27T09:00:20Z");
    await tick(services.runs);
    expect(await runCount()).toBe(0);
    clock = new Date("2026-10-27T13:00:20Z"); // 09:00 in New York (EDT, UTC-4)
    await tick(services.runs);
    expect(await runCount()).toBe(1);
  });

  it("shows the next run and can run early by hand", async () => {
    const id = await turnOn();
    const { workflows } = await (await app.request("/api/workflows")).json();
    expect(workflows[0]).toMatchObject({
      id,
      trigger: "schedule",
      nextRunAt: "2026-10-27T09:00:00.000Z",
    });

    const ran = await post(`/api/workflows/${id}/runs`);
    expect(ran.status).toBe(201);
    expect(created).toHaveLength(1);

    // Running early doesn't use up the scheduled slot.
    clock = new Date("2026-10-27T09:00:20Z");
    await tick(services.runs);
    expect(created).toHaveLength(2);
  });

  it("won't turn on a schedule it can't read", async () => {
    const bad = {
      ...examples.linearScheduledExample,
      trigger: { kind: "schedule", cron: "every morning", timezone: "Europe/London" },
    };
    const res = await (await post("/api/workflows", { definition: bad })).json();
    expect(res.status).toBe("draft");
    expect(res.issues[0].message).toMatch(/isn't a schedule we understand/);
  });
});
