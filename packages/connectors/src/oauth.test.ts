import { describe, expect, it } from "vitest";
import {
  authorizeUrl,
  createPkcePair,
  exchangeCode,
  needsRefresh,
  oauthProviders,
  refreshTokens,
} from "./index.js";

const client = { clientId: "cid", clientSecret: "secret" };
const now = new Date("2026-10-26T12:00:00Z");

function fakeTokenEndpoint(reply: Record<string, unknown>, status = 200) {
  const calls: URLSearchParams[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    calls.push(new URLSearchParams(init?.body as URLSearchParams));
    return new Response(JSON.stringify(reply), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("oauth", () => {
  it("builds provider-specific authorise links", async () => {
    const linear = new URL(
      authorizeUrl({
        provider: oauthProviders.linear,
        client,
        redirectUri: "http://localhost:5173/connections/callback",
        scopes: ["read", "write"],
        state: "s1",
      }),
    );
    expect(linear.origin + linear.pathname).toBe("https://linear.app/oauth/authorize");
    expect(linear.searchParams.get("scope")).toBe("read,write");
    expect(linear.searchParams.get("code_challenge")).toBeNull();

    const { challenge } = await createPkcePair();
    const google = new URL(
      authorizeUrl({
        provider: oauthProviders.google,
        client,
        redirectUri: "http://x/cb",
        scopes: ["a", "b"],
        state: "s2",
        codeChallenge: challenge,
      }),
    );
    expect(google.searchParams.get("scope")).toBe("a b");
    expect(google.searchParams.get("access_type")).toBe("offline");
    expect(google.searchParams.get("code_challenge")).toBe(challenge);
  });

  it("exchanges a code for tokens", async () => {
    const { calls, fetchImpl } = fakeTokenEndpoint({
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      scope: "read,write",
    });
    const tokens = await exchangeCode({
      provider: oauthProviders.linear,
      client,
      code: "c",
      redirectUri: "http://x/cb",
      fetch: fetchImpl,
      now,
    });
    expect(tokens).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: "2026-10-26T13:00:00.000Z",
      scopes: ["read", "write"],
    });
    expect(calls[0]?.get("grant_type")).toBe("authorization_code");
    expect(calls[0]?.get("client_secret")).toBe("secret");
  });

  it("keeps the refresh token when the provider doesn't send a new one", async () => {
    const { fetchImpl } = fakeTokenEndpoint({ access_token: "at2", expires_in: 60 });
    const refreshed = await refreshTokens({
      provider: oauthProviders.google,
      client,
      tokens: { accessToken: "at", refreshToken: "rt", scopes: ["s"] },
      fetch: fetchImpl,
      now,
    });
    expect(refreshed).toMatchObject({ accessToken: "at2", refreshToken: "rt", scopes: ["s"] });
  });

  it("reports refusals in plain words", async () => {
    const { fetchImpl } = fakeTokenEndpoint({ error: "invalid_grant" }, 400);
    await expect(
      exchangeCode({
        provider: oauthProviders.linear,
        client,
        code: "bad",
        redirectUri: "x",
        fetch: fetchImpl,
      }),
    ).rejects.toThrow("The app refused the connection (invalid_grant).");
  });

  it("knows when a token needs renewing", () => {
    expect(needsRefresh({ accessToken: "a", scopes: [] }, now)).toBe(false);
    expect(
      needsRefresh({ accessToken: "a", scopes: [], expiresAt: "2026-10-26T12:00:30Z" }, now),
    ).toBe(true);
    expect(
      needsRefresh({ accessToken: "a", scopes: [], expiresAt: "2026-10-26T13:00:00Z" }, now),
    ).toBe(false);
  });
});
