import { describe, expect, it } from "vitest";
import { createOAuth2Client, googleOAuth2, OAuth2Error } from "./oauth2.js";

function recorder(reply: (url: string, body: URLSearchParams) => Response) {
  const calls: { url: string; body?: URLSearchParams; auth?: string | null }[] = [];
  const impl = (async (url: URL | string, init?: RequestInit) => {
    const body = init?.body instanceof URLSearchParams ? init.body : undefined;
    calls.push({ url: String(url), body, auth: new Headers(init?.headers).get("authorization") });
    return reply(String(url), body ?? new URLSearchParams());
  }) as typeof fetch;
  return { impl, calls };
}

const google = googleOAuth2({
  scopes: ["https://www.googleapis.com/auth/gmail.send", "email"],
  clientId: "cid",
  clientSecret: "secret",
});

describe("oauth2", () => {
  it("asks Google for offline access, so the connection survives the hour", () => {
    const url = new URL(createOAuth2Client(google).authorizeUrl("st", "http://app/cb"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "cid",
      redirect_uri: "http://app/cb",
      response_type: "code",
      scope: "https://www.googleapis.com/auth/gmail.send email",
      state: "st",
      access_type: "offline",
      prompt: "consent",
    });
  });

  it("exchanges the code, refreshes, and labels the connection by email", async () => {
    const now = new Date("2026-10-28T09:00:00Z");
    const { impl, calls } = recorder((url, body) =>
      url.includes("userinfo")
        ? Response.json({ email: "sam@example.com" })
        : Response.json({
            access_token: body.get("grant_type") === "refresh_token" ? "ya29.new" : "ya29.first",
            refresh_token: body.get("grant_type") === "refresh_token" ? undefined : "1//refresh",
            expires_in: 3599,
            scope: "https://www.googleapis.com/auth/gmail.send email",
          }),
    );
    const client = createOAuth2Client(google, impl, () => now);
    expect(await client.exchangeCode("code1", "http://app/cb")).toEqual({
      accessToken: "ya29.first",
      refreshToken: "1//refresh",
      expiresAt: "2026-10-28T09:59:59.000Z",
      scopes: ["https://www.googleapis.com/auth/gmail.send", "email"],
    });
    expect(Object.fromEntries(calls[0]!.body!)).toMatchObject({
      grant_type: "authorization_code",
      code: "code1",
      redirect_uri: "http://app/cb",
      client_id: "cid",
      client_secret: "secret",
    });
    expect((await client.refresh!("1//refresh")).accessToken).toBe("ya29.new");
    expect(await client.describe("ya29.first")).toBe("sam@example.com");
    expect(calls.at(-1)?.auth).toBe("Bearer ya29.first");
  });

  it("explains a refusal in the provider's words", async () => {
    const { impl } = recorder(() =>
      Response.json({ error: "invalid_grant", error_description: "Bad Request" }, { status: 400 }),
    );
    const err = await createOAuth2Client(google, impl)
      .exchangeCode("x", "y")
      .catch((e) => e);
    expect(err).toBeInstanceOf(OAuth2Error);
    expect(err.message).toBe("Bad Request");
  });
});
