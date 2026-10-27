import { describe, expect, it } from "vitest";
import { createLinearConnector, createLinearOAuth, LinearAuthError } from "./linear.js";

const ctx = {
  credentials: { accessToken: "tok" },
  workspaceId: "ws_1",
  idempotencyKey: "run_1:step",
  attempt: 1,
  runId: "run_1",
};

function recordingFetch(reply: (body: { query: string; variables?: any }) => Response) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const impl = (async (url: URL | string, init?: RequestInit) => {
    const body =
      init?.body instanceof URLSearchParams
        ? Object.fromEntries(init.body)
        : JSON.parse(String(init?.body));
    calls.push({ url: String(url), headers: new Headers(init?.headers), body });
    return reply(body);
  }) as typeof fetch;
  return { impl, calls };
}

describe("linear", () => {
  it("creates a task in the first team when none is given", async () => {
    const { impl, calls } = recordingFetch(({ query, variables }) =>
      query.includes("teams")
        ? Response.json({ data: { teams: { nodes: [{ id: "team_1" }] } } })
        : Response.json({
            data: {
              issueCreate: {
                success: true,
                issue: {
                  id: "i1",
                  identifier: "ENG-1",
                  title: variables.input.title,
                  url: "u",
                  state: null,
                },
              },
            },
          }),
    );
    const out = await createLinearConnector(impl).actions!.createIssue!({ title: "Hello" }, ctx);
    expect(out).toMatchObject({ identifier: "ENG-1", title: "Hello" });
    expect(calls[1]!.body.variables.input).toMatchObject({ teamId: "team_1", title: "Hello" });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tok");
  });

  it("finds overdue, unfinished tasks in the shape workflows expect", async () => {
    const { impl, calls } = recordingFetch(() =>
      Response.json({
        data: {
          issues: {
            nodes: [
              {
                id: "i1",
                identifier: "ENG-2",
                title: "Late",
                url: "u",
                dueDate: "2026-10-01",
                state: { name: "In Progress", type: "started" },
                assignee: { email: "a@example.com" },
              },
            ],
          },
        },
      }),
    );
    const connector = createLinearConnector(impl, () => new Date("2026-10-27T10:00:00Z"));
    const out = (await connector.actions!.searchIssues!({ filter: "overdue" }, ctx)) as any;
    expect(calls[0]!.body.variables.filter).toEqual({
      state: { type: { nin: ["completed", "canceled"] } },
      dueDate: { lt: "2026-10-27" },
    });
    expect(out.items[0]).toMatchObject({ state: "started", assigneeEmail: "a@example.com" });
  });

  it("reports a rejected token as needing to reconnect", async () => {
    const { impl } = recordingFetch(() => new Response("", { status: 401 }));
    await expect(
      createLinearConnector(impl).actions!.updateIssue!({ id: "i1", title: "x" }, ctx),
    ).rejects.toBeInstanceOf(LinearAuthError);
  });

  it("passes Linear's GraphQL errors through", async () => {
    const { impl } = recordingFetch(() =>
      Response.json({ errors: [{ message: "Team not found" }] }),
    );
    await expect(
      createLinearConnector(impl).actions!.createIssue!({ title: "x", teamId: "nope" }, ctx),
    ).rejects.toThrow("Linear said: Team not found");
  });

  it("builds the sign-in address and exchanges the code", async () => {
    const { impl, calls } = recordingFetch(() =>
      Response.json({
        access_token: "a",
        refresh_token: "r",
        expires_in: 3600,
        scope: "read write",
      }),
    );
    const oauth = createLinearOAuth(
      { clientId: "cid", clientSecret: "secret" },
      impl,
      () => new Date("2026-10-27T10:00:00Z"),
    );
    const url = new URL(oauth.authorizeUrl("state_1", "http://localhost/cb"));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "cid",
      state: "state_1",
      redirect_uri: "http://localhost/cb",
      scope: "read,write",
      response_type: "code",
    });
    expect(url.searchParams.has("client_secret")).toBe(false);

    const tokens = await oauth.exchangeCode("code_1", "http://localhost/cb");
    expect(tokens).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: "2026-10-27T11:00:00.000Z",
      scopes: ["read", "write"],
    });
    expect(calls[0]!.body).toMatchObject({
      grant_type: "authorization_code",
      code: "code_1",
      client_secret: "secret",
    });
  });

  it("explains a failed code exchange", async () => {
    const { impl } = recordingFetch(() =>
      Response.json({ error: "invalid_grant", error_description: "Code expired" }, { status: 400 }),
    );
    const oauth = createLinearOAuth({ clientId: "c", clientSecret: "s" }, impl);
    await expect(oauth.exchangeCode("x", "y")).rejects.toThrow("Code expired");
  });
});
