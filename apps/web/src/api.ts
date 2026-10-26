import { sessionToken } from "./auth";

/** Thin fetch wrapper. Errors carry the API's plain-language message. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await sessionToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "We couldn't reach the server.");
  return body as T;
}
