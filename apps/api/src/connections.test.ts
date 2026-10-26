import { describe, expect, it } from "vitest";
import { createNodeDb } from "@tappet/db/node";
import { schema } from "@tappet/db";
import { createApp, type AppDeps } from "./app.js";
import type { Authenticator } from "./auth.js";
import { accessTokenFor, ConnectionNeedsAttention, openTokens } from "./credentials.js";
import { baseDeps } from "./setup.js";

const fakeAuth: Authenticator = {
  verify: async (req) => req.headers.get("authorization")?.replace("Bearer ", "") || null,
  profile: async () => ({}),
};

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

/** A pretend Linear token endpoint that records what it was sent. */
function fakeLinear(reply: () => Record<string, unknown> = () => ({ access_token: "lin_at" })) {
  const requests: { url: string; body: URLSearchParams }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), body: new URLSearchParams(init?.body as URLSearchParams) });
    return new Response(JSON.stringify(reply()), { status: 200 });
  }) as typeof fetch;
  return { requests, fetchImpl };
}

function setup(options: { now?: () => Date; reply?: () => Record<string, unknown> } = {}) {
  const linear = fakeLinear(options.reply);
  const db = createNodeDb(":memory:");
  const deps: AppDeps = {
    ...baseDeps(db, {}),
    auth: fakeAuth,
    now: options.now ?? (() => new Date()),
    connect: {
      credentialsKey: key,
      appUrl: "http://localhost:5173",
      clients: { linear: { clientId: "cid", clientSecret: "secret" } },
      fetch: linear.fetchImpl,
    },
  };
  return { app: createApp(deps), deps, db, linear };
}

const as = (who: string, method = "GET", body?: unknown) => ({
  method,
  headers: { "content-type": "application/json", authorization: `Bearer ${who}` },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function startLinear(app: ReturnType<typeof createApp>, who = "alice") {
  const res = await app.request("/api/connections/linear/start", as(who, "POST"));
  const { url } = (await res.json()) as { url: string };
  return new URL(url);
}

describe("connecting apps", () => {
  it("marks which apps are ready on this server", async () => {
    const { app } = setup();
    const { connectors } = await (await app.request("/api/connectors", as("alice"))).json();
    const ready = Object.fromEntries(
      connectors.map((c: { id: string; ready: boolean }) => [c.id, c.ready]),
    );
    expect(ready).toMatchObject({ linear: true, gmail: false, http: true });
  });

  it("connects Linear end to end and stores the token encrypted", async () => {
    const { app, db, deps, linear } = setup();
    const url = await startLinear(app);
    expect(url.origin).toBe("https://linear.app");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:5173/connections/callback");

    const done = await app.request(
      "/api/connections/complete",
      as("alice", "POST", { code: "the-code", state: url.searchParams.get("state") }),
    );
    expect(done.status).toBe(200);
    expect(linear.requests[0]?.body.get("code")).toBe("the-code");

    const [row] = await db.select().from(schema.connections);
    expect(row?.status).toBe("connected");
    expect(row?.encryptedCredentials).not.toContain("lin_at");
    expect((await openTokens(deps.connect!, row!.encryptedCredentials!)).accessToken).toBe(
      "lin_at",
    );

    // Credentials never come back out through the API.
    const listed = await (await app.request("/api/connections", as("alice"))).text();
    expect(listed).not.toContain("lin_at");
    expect(listed).not.toContain("encrypted");
  });

  it("won't let someone else finish your connection", async () => {
    const { app } = setup();
    const url = await startLinear(app, "alice");
    const res = await app.request(
      "/api/connections/complete",
      as("mallory", "POST", { code: "c", state: url.searchParams.get("state") }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects tampered and expired links", async () => {
    let now = new Date("2026-10-26T12:00:00Z");
    const { app } = setup({ now: () => now });
    const url = await startLinear(app);
    const state = url.searchParams.get("state")!;

    const tampered = await app.request(
      "/api/connections/complete",
      as("alice", "POST", { code: "c", state: state.slice(0, -4) + "AAAA" }),
    );
    expect(tampered.status).toBe(400);

    now = new Date("2026-10-26T12:11:00Z");
    const late = await app.request(
      "/api/connections/complete",
      as("alice", "POST", { code: "c", state }),
    );
    expect(late.status).toBe(400);
  });

  it("explains when an app isn't set up on this server", async () => {
    const { app } = setup();
    const res = await app.request("/api/connections/gmail/start", as("alice", "POST"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("Gmail isn't set up on this server yet.");
  });

  it("disconnects, forgets the token and asks Linear to revoke it", async () => {
    const { app, db, linear } = setup();
    const url = await startLinear(app);
    const { id } = await (
      await app.request(
        "/api/connections/complete",
        as("alice", "POST", { code: "c", state: url.searchParams.get("state") }),
      )
    ).json();

    expect((await app.request(`/api/connections/${id}`, as("bob", "DELETE"))).status).toBe(404);
    expect((await app.request(`/api/connections/${id}`, as("alice", "DELETE"))).status).toBe(200);

    const [row] = await db.select().from(schema.connections);
    expect(row).toMatchObject({ status: "revoked", encryptedCredentials: null });
    expect(linear.requests.at(-1)?.url).toBe("https://api.linear.app/oauth/revoke");
  });
});

describe("accessTokenFor", () => {
  async function connected(reply: () => Record<string, unknown>) {
    let now = new Date("2026-10-26T12:00:00Z");
    const env = setup({ now: () => now, reply });
    const url = await startLinear(env.app);
    const { id } = await (
      await env.app.request(
        "/api/connections/complete",
        as("alice", "POST", { code: "c", state: url.searchParams.get("state") }),
      )
    ).json();
    const [row] = await env.db.select().from(schema.connections);
    const get = () =>
      accessTokenFor({
        db: env.db,
        config: env.deps.connect!,
        manifests: env.deps.manifests,
        workspaceId: row!.workspaceId,
        connectionId: id,
        now,
      });
    return { ...env, get, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
  }

  it("renews an expired token and keeps working", async () => {
    let n = 0;
    const env = await connected(() => ({
      access_token: `at${++n}`,
      refresh_token: "rt",
      expires_in: 3600,
    }));
    expect(await env.get()).toBe("at1");
    env.advance(3600_000);
    expect(await env.get()).toBe("at2");
    expect(env.linear.requests.at(-1)?.body.get("grant_type")).toBe("refresh_token");
  });

  it("flags the connection when renewal fails", async () => {
    const env = await connected(() => ({ access_token: "at", expires_in: 60 })); // no refresh token
    env.advance(120_000);
    await expect(env.get()).rejects.toBeInstanceOf(ConnectionNeedsAttention);
    const [row] = await env.db.select().from(schema.connections);
    expect(row?.status).toBe("needs_reauth");
  });
});
