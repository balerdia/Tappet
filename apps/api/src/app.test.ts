import { beforeEach, describe, expect, it } from "vitest";
import { createNodeDb } from "@tappet/db/node";
import { examples } from "@tappet/workflow";
import { createApp } from "./app.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { baseDeps, seedDevWorkspace } from "./setup.js";

describe("api", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const db = createNodeDb(":memory:");
    await seedDevWorkspace(db);
    app = createApp(baseDeps(db, { TAPPET_DEV_AUTH: "1" }));
  });

  const json = (method: string, body?: unknown) => ({
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  it("requires sign-in when dev auth is off", async () => {
    const locked = createApp(baseDeps(createNodeDb(":memory:")));
    expect((await locked.request("/api/health")).status).toBe(200);
    expect((await locked.request("/api/workflows")).status).toBe(401);
  });

  it("previews a definition as sentences", async () => {
    const res = await app.request(
      "/api/workflows/preview",
      json("POST", { definition: examples.simpleExample }),
    );
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sentences[0]).toMatchObject({
      phrase: "When",
      text: "someone submits a contact form",
    });
  });

  // Needs no connection: an incoming web address that forwards to another one.
  const forward = {
    ...examples.simpleExample,
    steps: [
      {
        kind: "action",
        id: "forward",
        connector: "http",
        action: "request",
        input: { method: { literal: "POST" }, url: { literal: "https://example.com/hook" } },
      },
    ],
  };

  it("creates, edits, approves, pauses and exports a workflow", async () => {
    const created = await (
      await app.request("/api/workflows", json("POST", { definition: forward }))
    ).json();
    expect(created.status).toBe("needs_review");

    const edited = await (
      await app.request(
        `/api/workflows/${created.id}`,
        json("PUT", { definition: { ...forward, name: "Renamed" } }),
      )
    ).json();
    expect(edited.version).toBe(2);

    const activated = await (
      await app.request(`/api/workflows/${created.id}/activate`, json("POST"))
    ).json();
    expect(activated).toMatchObject({ status: "running", activeVersion: 2 });

    const paused = await app.request(`/api/workflows/${created.id}/pause`, json("POST"));
    expect((await paused.json()).status).toBe("paused");

    const exported = await (await app.request(`/api/workflows/${created.id}/export`)).json();
    expect(exported.versions).toHaveLength(2);
    expect(exported.versions[1].definition).toMatchObject({ id: created.id, version: 2 });
  });

  it("won't activate a workflow whose apps aren't connected", async () => {
    const created = await (
      await app.request("/api/workflows", json("POST", { definition: examples.simpleExample }))
    ).json();
    const res = await app.request(`/api/workflows/${created.id}/activate`, json("POST"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      status: "needs_connection",
      missing: [{ connector: "gmail" }],
    });
  });

  it("won't activate a workflow with problems", async () => {
    const broken = {
      ...examples.simpleExample,
      steps: [{ kind: "action", id: "x", connector: "gmail", action: "nope", input: {} }],
    };
    const created = await (
      await app.request("/api/workflows", json("POST", { definition: broken }))
    ).json();
    expect(created.status).toBe("draft");
    expect((await app.request(`/api/workflows/${created.id}/activate`, json("POST"))).status).toBe(
      422,
    );
  });

  it("returns friendly errors for bad input", async () => {
    const res = await app.request("/api/workflows/preview", { method: "POST", body: "{nope" });
    expect(res.status).toBe(400);
  });
});

describe("secrets", () => {
  it("round-trips and uses a fresh IV each time", async () => {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const a = await encryptSecret(key, "refresh-token");
    const b = await encryptSecret(key, "refresh-token");
    expect(a).not.toBe(b);
    expect(await decryptSecret(key, a)).toBe("refresh-token");
  });
});
