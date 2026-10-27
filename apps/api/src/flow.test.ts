import { beforeEach, describe, expect, it } from "vitest";
import { createLinearConnector, type OAuthClient, type OAuthTokens } from "@tappet/connectors";
import { createNodeDb } from "@tappet/db/node";
import { eq, schema } from "@tappet/db";
import { examples } from "@tappet/workflow";
import { createApp, createServices, type AppDeps } from "./app.js";
import type { Authenticator } from "./auth.js";
import { baseDeps } from "./setup.js";

// The whole path a new customer takes: sign up, connect Linear, turn on a
// Linear automation and run it. Clerk and Linear are replaced with fakes.

const key = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

const fakeAuth: Authenticator = {
  async verify(token) {
    return token.startsWith("good-") ? { subject: token.slice(5) } : undefined;
  },
  async profile(subject) {
    return { email: `${subject}@example.com`, name: "Sam Example" };
  },
};

function fakeLinearOAuth(log: string[], tokens: Partial<OAuthTokens> = {}): OAuthClient {
  return {
    authorizeUrl: (state, redirectUri) =>
      `https://linear.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    async exchangeCode(code, redirectUri) {
      log.push(`exchange:${code}:${redirectUri}`);
      return {
        accessToken: "lin_access_1",
        refreshToken: "lin_refresh_1",
        scopes: ["read", "write"],
        ...tokens,
      };
    },
    async refresh(refreshToken) {
      log.push(`refresh:${refreshToken}`);
      return { accessToken: "lin_access_2", scopes: ["read", "write"] };
    },
    describe: async () => "Acme",
  };
}

/** Pretends to be Linear's GraphQL API. Records the tokens it sees. */
function fakeLinearApi(seen: string[]) {
  return (async (_url: URL | string, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("authorization") ?? "");
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("teams")) {
      return Response.json({ data: { teams: { nodes: [{ id: "team_1" }] } } });
    }
    if (query.includes("issueCreate")) {
      return Response.json({
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "iss_1",
              identifier: "ENG-1",
              title: variables.input.title,
              url: "https://linear.app/acme/issue/ENG-1",
              state: { name: "Todo", type: "unstarted" },
            },
          },
        },
      });
    }
    return Response.json({ errors: [{ message: "unexpected query" }] });
  }) as typeof fetch;
}

describe("sign up → connect Linear → turn on → run", () => {
  let deps: AppDeps;
  let app: ReturnType<typeof createApp>;
  let oauthLog: string[];
  let linearTokens: string[];

  beforeEach(() => {
    oauthLog = [];
    linearTokens = [];
    const base = baseDeps(createNodeDb(":memory:"));
    deps = {
      ...base,
      auth: fakeAuth,
      credentialsKey: key(),
      appUrl: "http://localhost:5173",
      oauth: { linear: fakeLinearOAuth(oauthLog) },
      runtimes: [createLinearConnector(fakeLinearApi(linearTokens))],
    };
    app = createApp(deps);
  });

  const as = (
    token: string,
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) => ({
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  async function connectLinear(token: string) {
    const start = await app.request("/api/connections/linear/start", as(token, "POST"));
    expect(start.status).toBe(200);
    const { url } = await start.json();
    const state = new URL(url).searchParams.get("state")!;
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    return { state, cookie, url };
  }

  it("rejects missing and forged tokens", async () => {
    expect((await app.request("/api/me")).status).toBe(401);
    expect((await app.request("/api/me", as("forged"))).status).toBe(401);
  });

  it("creates an account and workspace on first sign-in, once", async () => {
    const first = await (await app.request("/api/me", as("good-sam"))).json();
    expect(first.user.email).toBe("sam@example.com");
    expect(first.workspace.id).toMatch(/^ws_/);
    const again = await (await app.request("/api/me", as("good-sam"))).json();
    expect(again.workspace.id).toBe(first.workspace.id);

    const other = await (await app.request("/api/me", as("good-alex"))).json();
    expect(other.workspace.id).not.toBe(first.workspace.id);
  });

  it("runs the whole flow", async () => {
    const token = "good-sam";

    // Turning on before connecting is refused, and says why.
    const created = await (
      await app.request(
        "/api/workflows",
        as(token, "POST", { definition: examples.linearTaskExample }),
      )
    ).json();
    expect(created.status).toBe("needs_review");
    const early = await app.request(`/api/workflows/${created.id}/activate`, as(token, "POST"));
    expect(early.status).toBe(409);
    expect((await early.json()).missing[0].connector).toBe("linear");

    // Connect Linear.
    const { state, cookie, url } = await connectLinear(token);
    expect(url).toContain(
      encodeURIComponent("http://localhost:5173/api/connections/linear/callback"),
    );
    const callback = await app.request(`/api/connections/linear/callback?code=abc&state=${state}`, {
      headers: { cookie },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(
      "http://localhost:5173/connections?connected=linear",
    );
    expect(oauthLog).toEqual([
      "exchange:abc:http://localhost:5173/api/connections/linear/callback",
    ]);

    const { connections } = await (await app.request("/api/connections", as(token))).json();
    expect(connections).toMatchObject([
      { connector: "linear", label: "Acme", status: "connected" },
    ]);
    expect(JSON.stringify(connections)).not.toContain("lin_access");

    const [stored] = await deps.db.select().from(schema.connections);
    expect(stored!.encryptedCredentials).toMatch(/^v1\./);
    expect(stored!.encryptedCredentials).not.toContain("lin_access");

    // Turn it on and run it.
    const on = await app.request(`/api/workflows/${created.id}/activate`, as(token, "POST"));
    expect((await on.json()).status).toBe("running");
    const ran = await app.request(`/api/workflows/${created.id}/runs`, as(token, "POST"));
    expect(ran.status).toBe(201);
    const { run } = await ran.json();
    expect(run.status).toBe("completed");
    expect(run.outputs.createTask).toMatchObject({
      identifier: "ENG-1",
      title: "Follow up with new customers",
      url: "https://linear.app/acme/issue/ENG-1",
    });
    expect(linearTokens.every((t) => t === "Bearer lin_access_1")).toBe(true);

    const { events } = await (await app.request("/api/activity", as(token))).json();
    expect(events.map((e: { type: string }) => e.type).sort()).toEqual([
      "action.succeeded",
      "run.completed",
    ]);
    const { runs } = await (
      await app.request(`/api/workflows/${created.id}/runs`, as(token))
    ).json();
    expect(runs).toHaveLength(1);

    // Another workspace can't see or run it.
    const stranger = await app.request(
      `/api/workflows/${created.id}/runs`,
      as("good-alex", "POST"),
    );
    expect(stranger.status).toBe(404);
  });

  it("only completes a callback in the browser that started it, once", async () => {
    const { state, cookie } = await connectLinear("good-sam");
    const noCookie = await app.request(`/api/connections/linear/callback?code=abc&state=${state}`);
    expect(noCookie.headers.get("location")).toContain("error=");

    const ok = await app.request(`/api/connections/linear/callback?code=abc&state=${state}`, {
      headers: { cookie },
    });
    expect(ok.headers.get("location")).toContain("connected=linear");
    const replay = await app.request(`/api/connections/linear/callback?code=abc&state=${state}`, {
      headers: { cookie },
    });
    expect(replay.headers.get("location")).toContain("error=");
    expect(oauthLog).toHaveLength(1);
  });

  it("handles someone declining access on Linear", async () => {
    const { state, cookie } = await connectLinear("good-sam");
    const declined = await app.request(
      `/api/connections/linear/callback?error=access_denied&state=${state}`,
      { headers: { cookie } },
    );
    expect(declined.headers.get("location")).toContain("error=");
    expect(await deps.db.select().from(schema.connections)).toHaveLength(0);
  });

  it("refreshes an expiring token before using it, keeping the refresh token", async () => {
    deps = {
      ...deps,
      oauth: {
        linear: fakeLinearOAuth(oauthLog, {
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      },
    };
    app = createApp(deps);
    const { state, cookie } = await connectLinear("good-sam");
    await app.request(`/api/connections/linear/callback?code=abc&state=${state}`, {
      headers: { cookie },
    });
    const me = await (await app.request("/api/me", as("good-sam"))).json();

    const ctx = await createServices(deps).credentials!.contextFor(me.workspace.id, "linear");
    expect(ctx?.credentials.accessToken).toBe("lin_access_2");
    expect(oauthLog).toContain("refresh:lin_refresh_1");

    // The rotated record still has the original refresh token.
    const tokens = await createServices(deps).credentials!.tokensFor(me.workspace.id, "linear");
    expect(tokens?.refreshToken).toBe("lin_refresh_1");
  });

  it("disconnects, and then won't run", async () => {
    const token = "good-sam";
    const { state, cookie } = await connectLinear(token);
    await app.request(`/api/connections/linear/callback?code=abc&state=${state}`, {
      headers: { cookie },
    });
    const created = await (
      await app.request(
        "/api/workflows",
        as(token, "POST", { definition: examples.linearTaskExample }),
      )
    ).json();
    await app.request(`/api/workflows/${created.id}/activate`, as(token, "POST"));

    await app.request("/api/connections/linear", as(token, "DELETE"));
    const ran = await app.request(`/api/workflows/${created.id}/runs`, as(token, "POST"));
    expect(ran.status).toBe(409);
    expect(await deps.db.select().from(schema.runs)).toHaveLength(0);
  });

  it("won't run automations that start by themselves", async () => {
    const token = "good-sam";
    const { state, cookie } = await connectLinear(token);
    await app.request(`/api/connections/linear/callback?code=abc&state=${state}`, {
      headers: { cookie },
    });
    const def = {
      ...examples.linearTaskExample,
      trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
    };
    const created = await (
      await app.request("/api/workflows", as(token, "POST", { definition: def }))
    ).json();
    await app.request(`/api/workflows/${created.id}/activate`, as(token, "POST"));
    const ran = await app.request(`/api/workflows/${created.id}/runs`, as(token, "POST"));
    expect(ran.status).toBe(409);
    const [wf] = await deps.db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, created.id));
    expect(wf!.status).toBe("running");
  });
});
