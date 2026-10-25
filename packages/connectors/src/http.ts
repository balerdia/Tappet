import { http } from "./manifests.js";
import type { ConnectorRuntime } from "./types.js";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Generic HTTP action. Uses fetch, so it runs on Node and Workers alike. */
export function createHttpConnector(fetchImpl: typeof fetch = fetch): ConnectorRuntime {
  return {
    manifest: http,
    actions: {
      async request(input, ctx) {
        const method = String(input.method ?? "GET").toUpperCase();
        if (!ALLOWED_METHODS.has(method)) throw new Error(`"${method}" isn't a supported method.`);

        const url = new URL(String(input.url));
        if (url.protocol !== "https:") throw new Error("Only https addresses are allowed.");

        const res = await fetchImpl(url, {
          method,
          headers: {
            "content-type": "application/json",
            "idempotency-key": ctx.idempotencyKey,
          },
          body:
            method === "GET" || input.body === undefined ? undefined : JSON.stringify(input.body),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`The server replied ${res.status}.`);

        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // Not JSON; keep the text.
        }
        return { status: res.status, body };
      },
    },
  };
}
