import { describe, expect, it } from "vitest";
import { createNodeDb } from "@tappet/db/node";
import { examples } from "@tappet/workflow";
import { createApp } from "./app.js";
import type { Authenticator } from "./auth.js";
import { authFromEnv, baseDeps } from "./setup.js";

// Stands in for Clerk: the bearer token is the subject.
const fakeAuth: Authenticator = {
  verify: async (req) => req.headers.get("authorization")?.replace("Bearer ", "") || null,
  profile: async (subject) => ({ email: `${subject}@example.com` }),
};

function appWithFakeAuth() {
  return createApp({ ...baseDeps(createNodeDb(":memory:"), {}), auth: fakeAuth });
}

const as = (who: string, init: RequestInit = {}) => ({
  ...init,
  headers: { "content-type": "application/json", authorization: `Bearer ${who}` },
});

describe("sign-in", () => {
  it("refuses requests without a valid token", async () => {
    const app = appWithFakeAuth();
    expect((await app.request("/api/workflows")).status).toBe(401);
  });

  it("gives each person their own workspace on first sign-in", async () => {
    const app = appWithFakeAuth();
    const create = (who: string) =>
      app.request(
        "/api/workflows",
        as(who, { method: "POST", body: JSON.stringify({ definition: examples.simpleExample }) }),
      );

    const alice = await (await create("clerk:alice")).json();
    await create("clerk:bob");

    const aliceList = await (await app.request("/api/workflows", as("clerk:alice"))).json();
    const bobList = await (await app.request("/api/workflows", as("clerk:bob"))).json();
    expect(aliceList.workflows).toHaveLength(1);
    expect(bobList.workflows).toHaveLength(1);
    expect(bobList.workflows[0].id).not.toBe(alice.id);

    // Bob can't read, change or export Alice's workflow.
    expect((await app.request(`/api/workflows/${alice.id}`, as("clerk:bob"))).status).toBe(404);
    expect(
      (
        await app.request(
          `/api/workflows/${alice.id}/activate`,
          as("clerk:bob", { method: "POST" }),
        )
      ).status,
    ).toBe(404);
    expect((await app.request(`/api/workflows/${alice.id}/export`, as("clerk:bob"))).status).toBe(
      404,
    );

    // Nor see, start or answer her runs.
    await app.request(`/api/workflows/${alice.id}/activate`, as("clerk:alice", { method: "POST" }));
    const { runId } = await (
      await app.request(`/api/workflows/${alice.id}/run`, as("clerk:alice", { method: "POST" }))
    ).json();
    expect(runId).toBeTruthy();
    expect((await (await app.request("/api/runs", as("clerk:bob"))).json()).runs).toEqual([]);
    expect((await app.request(`/api/runs/${runId}`, as("clerk:bob"))).status).toBe(404);
    expect(
      (await app.request(`/api/workflows/${alice.id}/run`, as("clerk:bob", { method: "POST" })))
        .status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `/api/runs/${runId}/approvals`,
          as("clerk:bob", {
            method: "POST",
            body: JSON.stringify({ path: "x", decision: "approved" }),
          }),
        )
      ).status,
    ).toBe(404);
  });

  it("handles two first requests arriving at once", async () => {
    const app = appWithFakeAuth();
    const results = await Promise.all([
      app.request("/api/workflows", as("clerk:carol")),
      app.request("/api/workflows", as("clerk:carol")),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
  });
});

describe("authFromEnv", () => {
  it("prefers Clerk, falls back to dev sign-in only when asked, else nothing", () => {
    expect(authFromEnv({})).toBeUndefined();
    expect(authFromEnv({ TAPPET_DEV_AUTH: "1" })).toBeDefined();
    const clerk = authFromEnv({ CLERK_SECRET_KEY: "sk_test_x", TAPPET_DEV_AUTH: "1" });
    expect(clerk).toBeDefined();
    expect(clerk).not.toBe(authFromEnv({ TAPPET_DEV_AUTH: "1" }));
  });

  it("rejects requests with no bearer token without calling Clerk", async () => {
    const clerk = authFromEnv({ CLERK_SECRET_KEY: "sk_test_x" })!;
    expect(await clerk.verify(new Request("http://x/api/workflows"))).toBeNull();
  });
});
