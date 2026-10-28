import nock from "nock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadPieceConnectors, type LoadedConnectors } from "./index.js";

// The real Gmail and Drive pieces, with Google faked at the network.

const ctx = {
  credentials: { accessToken: "ya29.test" },
  workspaceId: "ws_1",
  idempotencyKey: "run_1:step",
  attempt: 1,
  runId: "run_1",
};
const rawEmail = Buffer.from(
  [
    "From: Priya <priya@acme.example>",
    "To: sam@example.com",
    "Subject: Launch press kit",
    "Date: Mon, 26 Oct 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "We agreed to send the press kit by Friday.",
  ].join("\r\n"),
).toString("base64url");

let loaded: LoadedConnectors;
const runtime = (id: string) => loaded.runtimes.find((r) => r.manifest.id === id)!;
const google = () => nock(/googleapis\.com/);

beforeAll(async () => {
  nock.disableNetConnect();
  loaded = await loadPieceConnectors({ GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "secret" });
});
afterEach(() => nock.cleanAll());
afterAll(() => nock.enableNetConnect());

describe("Gmail and Drive pieces", () => {
  it("describes each app from its piece: name, sign-in and scopes", () => {
    const gmail = loaded.manifests.find((m) => m.id === "gmail")!;
    expect(gmail.name).toBe("Gmail");
    expect(gmail.auth).toMatchObject({ kind: "oauth2", provider: "google" });
    expect(gmail.auth.kind === "oauth2" && gmail.auth.scopes).toContain(
      "https://www.googleapis.com/auth/gmail.send",
    );
    expect(gmail.actions.map((a) => a.name)).toEqual(["sendEmail", "createDraft", "searchEmail"]);
    const signIn = new URL(loaded.oauth.drive!.authorizeUrl("st", "http://app/cb"));
    expect(signIn.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/drive");
    expect(signIn.searchParams.get("access_type")).toBe("offline");
  });

  it("sends an email as plain text, and keeps only the message id", async () => {
    let sent = "";
    let auth = "";
    google()
      .post("/gmail/v1/users/me/messages/send")
      .reply(function (_uri, body) {
        auth = String(this.req.headers.authorization);
        sent = Buffer.from((body as { raw: string }).raw, "base64url").toString();
        return [200, { id: "msg_1", threadId: "t_1" }];
      })
      .get(/userinfo/)
      .optionally()
      .reply(200, { email: "sam@example.com" });

    const out = await runtime("gmail").actions!.sendEmail!(
      { to: "priya@acme.example, ops@acme.example", subject: "Press kit", body: "Attached soon." },
      ctx,
    );
    expect(out).toEqual({ id: "msg_1" });
    expect(auth).toBe("Bearer ya29.test");
    expect(sent).toContain("To: priya@acme.example, ops@acme.example");
    const subject = sent.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)?.[1];
    expect(Buffer.from(subject ?? "", "base64").toString()).toBe("Press kit");
    expect(sent).toContain("text/plain");
  });

  it("finds emails as records Organise can cite", async () => {
    google()
      .get("/gmail/v1/users/me/messages")
      .query((q) => q.q === '"launch"')
      .reply(200, { messages: [{ id: "m1", threadId: "t1" }] })
      .get("/gmail/v1/users/me/messages/m1")
      .query(true)
      .reply(200, { id: "m1", raw: rawEmail });

    const [record] = await runtime("gmail").search!("launch", ctx);
    expect(record).toEqual({
      connector: "gmail",
      id: "m1",
      kind: "email",
      title: "Launch press kit",
      url: "https://mail.google.com/mail/u/0/#all/m1",
      text: 'From "Priya" <priya@acme.example>.\n\nWe agreed to send the press kit by Friday.',
      author: '"Priya" <priya@acme.example>',
      updatedAt: "2026-10-26T10:00:00.000Z",
    });
  });

  it("finds Drive files by the text inside them", async () => {
    let q = "";
    google()
      .get("/drive/v3/files")
      .query((query) => {
        q = String(query.q);
        return true;
      })
      .reply(200, {
        files: [
          {
            id: "f1",
            name: "Launch plan",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2026-10-20T10:00:00.000Z",
          },
        ],
      });

    const [record] = await runtime("drive").search!("launch", ctx);
    expect(q).toContain("fullText contains 'launch'");
    expect(record).toMatchObject({
      connector: "drive",
      kind: "document",
      title: "Launch plan",
      url: "https://drive.google.com/open?id=f1",
      text: "Google Doc, changed 2026-10-20.",
    });
    expect(await runtime("drive").search!("", ctx)).toEqual([]);
  });

  it("never lets a token into an error message", async () => {
    google()
      .post("/gmail/v1/users/me/messages/send")
      .replyWithError('request failed {"authorization":"Bearer ya29.test","x":1}\nstack line');
    google()
      .get(/userinfo/)
      .optionally()
      .reply(200, { email: "sam@example.com" });
    const err = (await runtime("gmail").actions!.sendEmail!(
      { to: "a@b.c", subject: "s", body: "b" },
      ctx,
    ).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("ya29.test");
    expect(err.message).not.toContain("stack line");
    expect(err.message).toContain("[hidden]");
  });

  it("refuses inputs an action doesn't take, rather than dropping them", async () => {
    await expect(
      runtime("gmail").actions!.sendEmail!({ to: "a@b.c", subject: "s", body: "b", cc: "x" }, ctx),
    ).rejects.toThrow('"sendEmail" in Gmail doesn\'t take "cc".');
  });
});
