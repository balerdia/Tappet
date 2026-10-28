import type { OAuthClient, OAuthTokens } from "./types.js";

/**
 * A standard OAuth 2.0 authorization-code client. Most apps follow the
 * standard, so connecting a new one is a set of addresses and scopes (often
 * read straight from its Activepieces piece) rather than new code.
 */
export type OAuth2Config = {
  /** Shown in errors, e.g. "Google". */
  providerName: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string;
  clientSecret: string;
  /** Extra sign-in parameters the provider needs, such as Google's `access_type`. */
  extraAuthParams?: Record<string, string>;
  /** A readable label for the connection, such as the account's email. */
  describe?: (accessToken: string, fetchImpl: typeof fetch) => Promise<string>;
  revoke?: (token: string, fetchImpl: typeof fetch) => Promise<void>;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

/** The provider refused. The person needs to connect again. */
export class OAuth2Error extends Error {}

export function createOAuth2Client(
  config: OAuth2Config,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): OAuthClient {
  async function token(params: Record<string, string>): Promise<OAuthTokens> {
    const res = await fetchImpl(config.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        ...params,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || !body.access_token) {
      throw new OAuth2Error(
        body.error_description ?? body.error ?? `${config.providerName} replied ${res.status}.`,
      );
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: body.expires_in
        ? new Date(now().getTime() + body.expires_in * 1000).toISOString()
        : undefined,
      scopes: body.scope ? body.scope.split(/[ ,]+/).filter(Boolean) : config.scopes,
    };
  }

  return {
    authorizeUrl(state, redirectUri) {
      const url = new URL(config.authUrl);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: config.scopes.join(" "),
        state,
        ...config.extraAuthParams,
      }).toString();
      return url.toString();
    },
    exchangeCode: (code, redirectUri) =>
      token({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    refresh: (refreshToken) => token({ grant_type: "refresh_token", refresh_token: refreshToken }),
    describe: (accessToken) =>
      config.describe
        ? config.describe(accessToken, fetchImpl)
        : Promise.resolve(config.providerName),
    revoke: config.revoke ? (accessToken) => config.revoke!(accessToken, fetchImpl) : undefined,
  };
}

/** Google's flavour: offline access for a refresh token, labelled by email. */
export function googleOAuth2(opts: {
  authUrl?: string;
  tokenUrl?: string;
  scopes: string[];
  clientId: string;
  clientSecret: string;
}): OAuth2Config {
  return {
    providerName: "Google",
    authUrl: opts.authUrl ?? "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: opts.tokenUrl ?? "https://oauth2.googleapis.com/token",
    scopes: opts.scopes,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    // Without these Google gives no refresh token, and the connection dies in an hour.
    extraAuthParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    async describe(accessToken, fetchImpl) {
      const res = await fetchImpl("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const body = (await res.json().catch(() => ({}))) as { email?: string };
      return body.email ?? "Google";
    },
    async revoke(token, fetchImpl) {
      await fetchImpl("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      });
    },
  };
}
