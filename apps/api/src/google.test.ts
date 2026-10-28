import nock from "nock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createNodeDb } from "@tappet/db/node";
import { schema } from "@tappet/db";
import { loadPieceConnectors, type LoadedConnectors } from "@tappet/pieces";
import { createApp, type AppDeps } from "./app.js";
import type { Authenticator } from "./auth.js";
import { baseDeps, withConnectors } from "./setup.js";

// Connect Gmail, run an automation that sends through the real Gmail piece,
// and ask Organise across Gmail and Drive. Google is faked at the network.

const fakeAuth: Authenticator = {
  verify: async () => ({ subject: "sam" }),
  profile: async () => ({ email: "sam@example.com", name: "Sam" }),
};
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

let pieces: LoadedConnectors;
beforeAll(async () => {
  nock.disableNetConnect();
  pieces = await loadPieceConnectors({ GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "secret" });
});
afterEach(() => nock.cleanAll());
afterAll(() => nock.enableNetConnect());

function setup() {
  const db = createNodeDb(":memory:");
  const deps: AppDeps = {
    ...withConnectors(baseDeps(db), pieces),
    auth: fakeAuth,
    credentialsKey: key,
    appUrl: "http://localhost:5173",
  };
  const app = createApp(deps);
  const call = async (path: string, method = "GET", body?: unknown, headers = {}) =>
    app.request(`/api${path}`, {
      method,
      headers: { authorization: "Bearer t", "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { db, call };
}

/** Google's sign-in, as seen by the server: a token exchange and a userinfo lookup. */
function fakeGoogleSignIn() {
  const exchanged: Record<string, string>[] = [];
  nock("https://oauth2.googleapis.com")
    .post("/token")
    .reply(200, (_uri, body) => {
      exchanged.push(Object.fromEntries(new URLSearchParams(String(body))));
      return { access_token: "ya29.real-looking", refresh_token: "1//r", expires_in: 3599 };
    });
  nock("https://www.googleapis.com")
    .get("/oauth2/v2/userinfo")
    .reply(200, { email: "sam@gmail.com" });
  return exchanged;
}

async function connect(env: ReturnType<typeof setup>, connector: string) {
  const exchanged = fakeGoogleSignIn();
  const start = await env.call(`/connections/${connector}/start`, "POST");
  const { url } = await start.json();
  const state = new URL(url).searchParams.get("state")!;
  const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
  const back = await env.call(
    `/connections/${connector}/callback?code=g-code&state=${state}`,
    "GET",
    undefined,
    { cookie },
  );
  return { url: new URL(url), back: back.headers.get("location"), exchanged };
}

describe("Gmail and Drive through Activepieces", () => {
  it("connects Gmail with Google, then sends an email from an automation", async () => {
    const env = setup();
    const { url, back, exchanged } = await connect(env, "gmail");
    expect(url.host).toBe("accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:5173/api/connections/gmail/callback",
    );
    expect(back).toBe("http://localhost:5173/connections?connected=gmail");
    expect(exchanged[0]).toMatchObject({ grant_type: "authorization_code", code: "g-code" });
    const { connections } = await (await env.call("/connections")).json();
    expect(connections).toMatchObject([
      { connector: "gmail", status: "connected", label: "sam@gmail.com" },
    ]);

    const def = {
      schemaVersion: 1,
      id: "x",
      version: 1,
      name: "Say hello",
      trigger: { kind: "manual" },
      steps: [
        {
          kind: "action",
          id: "send",
          connector: "gmail",
          action: "sendEmail",
          input: {
            to: { literal: "priya@acme.example" },
            subject: { literal: "Hello" },
            body: { literal: "Sent by Tappet." },
          },
        },
      ],
    };
    const created = await (await env.call("/workflows", "POST", { definition: def })).json();
    expect(created.issues).toEqual([]);
    expect((await env.call(`/workflows/${created.id}/activate`, "POST")).status).toBe(200);

    let auth = "";
    // The piece checks who it's sending as before it sends.
    nock("https://www.googleapis.com")
      .get("/oauth2/v2/userinfo")
      .reply(200, { email: "sam@gmail.com" });
    nock("https://gmail.googleapis.com")
      .post("/gmail/v1/users/me/messages/send")
      .reply(function () {
        auth = String(this.req.headers.authorization);
        return [200, { id: "msg_9" }];
      });
    const ran = await (await env.call(`/workflows/${created.id}/runs`, "POST")).json();
    expect(ran.run).toMatchObject({ status: "completed", outputs: { send: { id: "msg_9" } } });
    expect(auth).toBe("Bearer ya29.real-looking");
    const detail = await (await env.call(`/runs/${ran.run.id}`)).json();
    expect(detail.events.map((e: { message: string }) => e.message)).toEqual([
      "Done: send an email.",
      "Finished.",
    ]);
    // Nothing about the request settings ends up in the run history.
    const [run] = await env.db.select().from(schema.runs);
    expect(JSON.stringify(run!.state)).not.toContain("proxy");
  });

  it("answers Organise questions from Gmail and Drive", async () => {
    const env = setup();
    await connect(env, "gmail");
    await connect(env, "drive");
    nock("https://gmail.googleapis.com")
      .get("/gmail/v1/users/me/messages")
      .query(true)
      .reply(200, { messages: [] });
    nock("https://www.googleapis.com")
      .get("/drive/v3/files")
      .query(true)
      .reply(200, {
        files: [{ id: "f1", name: "Launch plan", modifiedTime: "2026-10-20T10:00:00.000Z" }],
      });

    const answer = await (await env.call("/organise/ask", "POST", { question: "launch" })).json();
    expect(answer.sources).toEqual(
      expect.arrayContaining([
        { connector: "gmail", name: "Gmail", status: "searched", found: 0 },
        { connector: "drive", name: "Google Drive", status: "searched", found: 1 },
      ]),
    );
    expect(answer.matches[0]).toMatchObject({
      title: "Launch plan",
      url: "https://drive.google.com/open?id=f1",
    });
  });
});
