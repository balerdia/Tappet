import { describe, expect, it } from "vitest";
import { examples, validateWorkflow } from "@tappet/workflow";
import {
  builtInManifests,
  catalogFromManifests,
  createActionResolver,
  createHttpConnector,
} from "./index.js";

describe("connectors", () => {
  const catalog = catalogFromManifests(builtInManifests);

  it("provides a catalog the example workflows validate against", () => {
    const result = validateWorkflow(examples.advancedExample, catalog);
    expect(result.issues).toEqual([]);
  });

  it("sends the idempotency key with web requests", async () => {
    let seen: Headers | undefined;
    const fakeFetch = (async (_url: URL, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;

    const resolve = createActionResolver([createHttpConnector(fakeFetch)], () => ({
      credentials: {},
      workspaceId: "ws_1",
    }));
    const handler = resolve("http", "request");
    const out = await handler!(
      { method: "POST", url: "https://example.com/hook", body: { a: 1 } },
      { idempotencyKey: "run_1:step", attempt: 1, runId: "run_1" },
    );
    expect(out).toEqual({ status: 200, body: { ok: true } });
    expect(seen?.get("idempotency-key")).toBe("run_1:step");
  });

  it("refuses plain http addresses", async () => {
    const handler = createHttpConnector().actions!.request!;
    await expect(
      handler(
        { url: "http://example.com" },
        { credentials: {}, workspaceId: "w", idempotencyKey: "k", attempt: 1, runId: "r" },
      ),
    ).rejects.toThrow(/https/);
  });
});
