import { beforeAll, describe, expect, it, vi } from "vitest";
import { createActionResolver } from "@tappet/connectors";
import { advance, examples, startRun } from "@tappet/workflow";
import { linearRuntime } from "./index.js";

// A pretend Linear GraphQL API. Installed before the piece loads, because
// pieces capture fetch on first load.
const requests: { auth: string | null; query: string; variables: Record<string, unknown> }[] = [];
let reply: (query: string) => unknown = () => ({});

beforeAll(() => {
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push({
      auth: new Headers(init?.headers).get("authorization"),
      query: body.query,
      variables: body.variables,
    });
    return new Response(JSON.stringify({ data: reply(body.query) }), {
      headers: { "content-type": "application/json" },
    });
  });
});

const ctx = { idempotencyKey: "run_1:step", attempt: 1, runId: "run_1" };
const connected = { credentials: { accessToken: "lin_oauth_token" }, workspaceId: "ws_1" };

describe("Linear through the Activepieces piece", () => {
  it("searches with our input names and the OAuth token", async () => {
    reply = () => ({
      searchIssues: {
        nodes: [{ id: "i1", title: "Send press kit", state: { type: "unstarted" } }],
        pageInfo: { hasNextPage: false },
      },
    });
    const search = linearRuntime().actions!.searchIssues!;
    const out = (await search({ query: "press kit" }, { ...connected, ...ctx })) as {
      items: { title: string; state_type: string }[];
    };

    expect(out.items[0]).toMatchObject({ title: "Send press kit", state_type: "unstarted" });
    const last = requests.at(-1)!;
    expect(last.auth).toBe("Bearer lin_oauth_token");
    expect(last.variables).toMatchObject({ term: "press kit" });
  });

  it("refuses inputs it doesn't understand instead of dropping them", async () => {
    const create = linearRuntime().actions!.createIssue!;
    await expect(
      create({ teamId: "t1", title: "x", colour: "red" }, { ...connected, ...ctx }),
    ).rejects.toThrow('"createIssue" in Linear doesn\'t take "colour".');
  });

  it("needs a connection", async () => {
    const search = linearRuntime().actions!.searchIssues!;
    await expect(
      search({ query: "x" }, { credentials: {}, workspaceId: "ws_1", ...ctx }),
    ).rejects.toThrow("Linear isn't connected.");
  });

  it("runs inside a real workflow run", async () => {
    reply = () => ({
      searchIssues: {
        nodes: [
          { id: "i1", title: "Brief", state: { type: "started" }, assignee: { email: "a@x.com" } },
          { id: "i2", title: "Copy", state: { type: "completed" }, assignee: { email: "b@x.com" } },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const emailed: unknown[] = [];
    const linearAction = createActionResolver([linearRuntime()], () => connected);
    const resolveAction = (connector: string, action: string) =>
      connector === "gmail"
        ? async (input: Record<string, unknown>) => emailed.push(input.to)
        : linearAction(connector, action);

    const def = examples.advancedExample;
    const now = new Date("2026-10-27T09:00:00Z");
    const result = await advance(def, startRun(def, "run_1", {}, now), {
      now: () => now,
      resolveAction,
    });
    expect(result.status).toBe("completed");
    expect(emailed).toEqual(["a@x.com"]);
  });
});
