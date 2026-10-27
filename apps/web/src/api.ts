type TokenGetter = () => Promise<string | null>;
let getToken: TokenGetter = async () => null;

/** Set once by the sign-in provider so every request carries the session token. */
export function setTokenGetter(fn: TokenGetter) {
  getToken = fn;
}

/** Thin fetch wrapper. Errors carry the API's plain-language message. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? "We couldn't reach the server.", res.status, body);
  return body as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}
