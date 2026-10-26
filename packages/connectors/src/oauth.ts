/**
 * OAuth for connecting apps. We own these flows (Clerk only handles sign-in),
 * so every app can offer one-click "Connect" with no middleman and no
 * per-call fees. Everything here is pure apart from the injected fetch, so it
 * runs the same on Workers and Node.
 */

export type OAuthProviderId = "google" | "linear" | "microsoft";

export type OAuthProviderSpec = {
  id: OAuthProviderId;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  scopeSeparator: " " | ",";
  /** Proof Key for Code Exchange, where the provider supports it. */
  pkce: boolean;
  extraAuthorizeParams?: Record<string, string>;
  /** Environment variables holding this server's client credentials. */
  env: { clientId: string; clientSecret: string };
};

export const oauthProviders: Record<OAuthProviderId, OAuthProviderSpec> = {
  google: {
    id: "google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    scopeSeparator: " ",
    pkce: true,
    // Offline access gives a refresh token, so automations keep running.
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
    env: { clientId: "GOOGLE_CLIENT_ID", clientSecret: "GOOGLE_CLIENT_SECRET" },
  },
  linear: {
    id: "linear",
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    revokeUrl: "https://api.linear.app/oauth/revoke",
    scopeSeparator: ",",
    pkce: false,
    extraAuthorizeParams: { prompt: "consent" },
    env: { clientId: "LINEAR_CLIENT_ID", clientSecret: "LINEAR_CLIENT_SECRET" },
  },
  microsoft: {
    id: "microsoft",
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopeSeparator: " ",
    pkce: true,
    env: { clientId: "MICROSOFT_CLIENT_ID", clientSecret: "MICROSOFT_CLIENT_SECRET" },
  },
};

export type OAuthClient = { clientId: string; clientSecret: string };

export type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  /** ISO time the access token stops working, when the provider says. */
  expiresAt?: string;
  scopes: string[];
};

export function authorizeUrl(params: {
  provider: OAuthProviderSpec;
  client: OAuthClient;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge?: string;
}): string {
  const { provider } = params;
  const url = new URL(provider.authorizeUrl);
  const query: Record<string, string> = {
    response_type: "code",
    client_id: params.client.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scopes.join(provider.scopeSeparator),
    state: params.state,
    ...provider.extraAuthorizeParams,
  };
  if (provider.pkce && params.codeChallenge) {
    query.code_challenge = params.codeChallenge;
    query.code_challenge_method = "S256";
  }
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}

async function tokenRequest(
  provider: OAuthProviderSpec,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
  now: Date,
  previous?: TokenSet,
): Promise<TokenSet> {
  const res = await fetchImpl(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== "string") {
    const reason = typeof json.error === "string" ? json.error : `status ${res.status}`;
    throw new OAuthError(`The app refused the connection (${reason}).`, reason);
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : undefined;
  const scope = typeof json.scope === "string" ? json.scope : undefined;
  return {
    accessToken: json.access_token,
    // Providers often omit the refresh token on refresh; keep the old one.
    refreshToken:
      typeof json.refresh_token === "string" ? json.refresh_token : previous?.refreshToken,
    expiresAt: expiresIn ? new Date(now.getTime() + expiresIn * 1000).toISOString() : undefined,
    scopes: scope ? scope.split(/[ ,]+/).filter(Boolean) : (previous?.scopes ?? []),
  };
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function exchangeCode(params: {
  provider: OAuthProviderSpec;
  client: OAuthClient;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
  fetch?: typeof fetch;
  now?: Date;
}): Promise<TokenSet> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.client.clientId,
    client_secret: params.client.clientSecret,
  };
  if (params.codeVerifier) body.code_verifier = params.codeVerifier;
  return tokenRequest(params.provider, body, params.fetch ?? fetch, params.now ?? new Date());
}

export function refreshTokens(params: {
  provider: OAuthProviderSpec;
  client: OAuthClient;
  tokens: TokenSet;
  fetch?: typeof fetch;
  now?: Date;
}): Promise<TokenSet> {
  if (!params.tokens.refreshToken) {
    return Promise.reject(new OAuthError("This connection can't be renewed.", "no_refresh_token"));
  }
  return tokenRequest(
    params.provider,
    {
      grant_type: "refresh_token",
      refresh_token: params.tokens.refreshToken,
      client_id: params.client.clientId,
      client_secret: params.client.clientSecret,
    },
    params.fetch ?? fetch,
    params.now ?? new Date(),
    params.tokens,
  );
}

/** Best effort: tells the app to forget the token. Failures are ignored. */
export async function revokeToken(params: {
  provider: OAuthProviderSpec;
  client: OAuthClient;
  token: string;
  fetch?: typeof fetch;
}): Promise<void> {
  if (!params.provider.revokeUrl) return;
  await (params.fetch ?? fetch)(params.provider.revokeUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: params.token,
      client_id: params.client.clientId,
      client_secret: params.client.clientSecret,
    }),
  }).catch(() => undefined);
}

/** True when the access token has expired or will within `marginMs`. */
export function needsRefresh(tokens: TokenSet, now: Date, marginMs = 60_000): boolean {
  return (
    tokens.expiresAt !== undefined &&
    new Date(tokens.expiresAt).getTime() - marginMs <= now.getTime()
  );
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}
