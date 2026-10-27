import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { and, desc, eq, lte, schema, sql, type Database } from "@tappet/db";
import type { ConnectorManifest, ConnectorRuntime, OAuthClient } from "@tappet/connectors";
import {
  connectorsUsed,
  describeWorkflow,
  nextScheduledRun,
  validateWorkflow,
  type Catalog,
  type WorkflowDefinition,
  type WorkflowStatus,
} from "@tappet/workflow";
import { bearerToken, findOrCreateAccount, type Authenticator } from "./auth.js";
import { createCredentialStore } from "./credentials.js";
import { createRunHost } from "./runs.js";

export type AppDeps = {
  db: Database;
  catalog: Catalog;
  manifests: ConnectorManifest[];
  /** Connectors that can do things, as opposed to just being described. */
  runtimes: ConnectorRuntime[];
  /** OAuth clients for the connectors this server can connect, by connector id. */
  oauth: Record<string, OAuthClient>;
  /** Encrypts stored connection tokens. Without it, nothing can be connected. */
  credentialsKey?: string;
  /** The web app's origin. Defaults to the origin of each request. */
  appUrl?: string;
  now: () => Date;
  newId: (prefix: string) => string;
  /** Real sign-in. Checked on every request except health and OAuth callbacks. */
  auth?: Authenticator;
  /**
   * Development only: treat every request as the seeded dev user. Takes
   * precedence over `auth`.
   */
  devAuth?: { userId: string; workspaceId: string };
};

/** Credentials and the run host, built once from the app's deps so every host shares them. */
export function createServices(deps: AppDeps) {
  const credentials = deps.credentialsKey
    ? createCredentialStore({
        db: deps.db,
        key: deps.credentialsKey,
        oauth: deps.oauth,
        now: deps.now,
        newId: deps.newId,
      })
    : undefined;
  const runs = createRunHost({
    db: deps.db,
    runtimes: deps.runtimes,
    credentials,
    now: deps.now,
    newId: deps.newId,
  });
  return { credentials, runs };
}

const OAUTH_COOKIE = "tappet_oauth";
const OAUTH_TTL_MS = 10 * 60_000;

type Env = { Variables: { userId: string; workspaceId: string } };

const DefinitionBody = z.object({ definition: z.unknown() });
const RunBody = z.object({ trigger: z.unknown().optional() }).optional();

export function createApp(deps: AppDeps, services = createServices(deps)) {
  const { db } = deps;
  const { credentials, runs } = services;
  const app = new Hono<Env>().basePath("/api");

  const appUrl = (requestUrl: string) => deps.appUrl ?? new URL(requestUrl).origin;
  const runtimeFor = (id: string) => deps.runtimes.find((r) => r.manifest.id === id);

  app.get("/health", (c) => c.json({ ok: true }));

  // ---------- OAuth callback ----------
  // Arrives as a redirect from the provider, so it carries no sign-in token.
  // It's trusted only if the state matches a row we created and the cookie
  // set in the same browser when the flow started.

  app.get("/connections/:connector/callback", async (c) => {
    const connector = c.req.param("connector");
    const back = (query: Record<string, string>) =>
      c.redirect(`${appUrl(c.req.url)}/connections?${new URLSearchParams(query)}`);

    const stateId = c.req.query("state");
    const cookie = getCookie(c, OAUTH_COOKIE);
    deleteCookie(c, OAUTH_COOKIE, { path: "/api/connections" });
    if (!stateId || stateId !== cookie) {
      return back({ error: "That sign-in link didn't come from this browser. Please try again." });
    }
    const [pending] = await db
      .select()
      .from(schema.oauthStates)
      .where(eq(schema.oauthStates.id, stateId));
    await db.delete(schema.oauthStates).where(eq(schema.oauthStates.id, stateId));
    await db
      .delete(schema.oauthStates)
      .where(lte(schema.oauthStates.expiresAt, deps.now().toISOString()));
    if (
      !pending ||
      pending.connector !== connector ||
      pending.expiresAt < deps.now().toISOString()
    ) {
      return back({ error: "That sign-in took too long or was already used. Please try again." });
    }

    const client = deps.oauth[connector];
    const manifest = deps.manifests.find((m) => m.id === connector);
    const code = c.req.query("code");
    if (!client || !credentials || !manifest)
      return back({ error: "This app can't be connected here." });
    if (!code) {
      return back({ error: `${manifest.name} didn't grant access.` });
    }

    try {
      const tokens = await client.exchangeCode(code, pending.redirectUri);
      const label = await client.describe(tokens.accessToken).catch(() => manifest.name);
      await credentials.save(pending.workspaceId, connector, label, tokens, pending.userId);
    } catch (err) {
      console.error(err);
      return back({ error: `We couldn't finish connecting ${manifest.name}. Please try again.` });
    }
    await audit(pending.workspaceId, pending.userId, "connection.created", connector);
    return back({ connected: connector });
  });

  // ---------- Sign-in ----------

  app.use("*", async (c, next) => {
    if (deps.devAuth) {
      c.set("userId", deps.devAuth.userId);
      c.set("workspaceId", deps.devAuth.workspaceId);
      return next();
    }
    const token = bearerToken(c.req.header("authorization"));
    const identity = token && deps.auth ? await deps.auth.verify(token) : undefined;
    if (!identity) return c.json({ error: "Please sign in." }, 401);
    const account = await findOrCreateAccount(db, deps.auth!, identity, deps.newId);
    c.set("userId", account.userId);
    c.set("workspaceId", account.workspaceId);
    await next();
  });

  app.get("/me", async (c) => {
    const [user] = await db
      .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, c.get("userId")));
    const [workspace] = await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, c.get("workspaceId")));
    return c.json({ user, workspace });
  });

  function preview(definition: unknown) {
    const result = validateWorkflow(definition, deps.catalog);
    return {
      ok: result.ok,
      issues: result.issues,
      sentences: result.ok ? describeWorkflow(result.definition, deps.catalog) : [],
    };
  }

  async function audit(
    workspaceId: string,
    actorId: string,
    action: string,
    subject: string,
    detail?: unknown,
  ) {
    await db.insert(schema.auditLog).values({ workspaceId, actorId, action, subject, detail });
  }

  async function findWorkflow(workspaceId: string, id: string) {
    const [row] = await db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.id, id), eq(schema.workflows.workspaceId, workspaceId)));
    return row;
  }

  async function findVersion(workflowId: string, version: number) {
    const [row] = await db
      .select()
      .from(schema.workflowVersions)
      .where(
        and(
          eq(schema.workflowVersions.workflowId, workflowId),
          eq(schema.workflowVersions.version, version),
        ),
      );
    return row;
  }

  // ---------- Connections ----------

  /**
   * Which connectors are set up, and which need connecting before a
   * definition can be turned on. Empty when everything's ready.
   */
  async function missingConnections(workspaceId: string, def: WorkflowDefinition) {
    const rows = await db
      .select()
      .from(schema.connections)
      .where(eq(schema.connections.workspaceId, workspaceId));
    const connected = new Set(rows.filter((r) => r.status === "connected").map((r) => r.connector));
    const missing: { connector: string; name: string; reason: string }[] = [];
    for (const id of connectorsUsed(def)) {
      const manifest = deps.manifests.find((m) => m.id === id);
      const name = manifest?.name ?? id;
      if (manifest?.auth.kind !== "none" && !connected.has(id)) {
        missing.push({ connector: id, name, reason: `Connect ${name} first.` });
      } else if (!runtimeFor(id) && manifest?.actions.length) {
        missing.push({ connector: id, name, reason: `Tappet can't use ${name} yet.` });
      }
    }
    return missing;
  }

  app.get("/connectors", (c) =>
    c.json({
      connectors: deps.manifests.map((m) => ({
        ...m,
        connectable: Boolean(deps.oauth[m.id] && credentials),
        available: m.auth.kind === "none" || Boolean(runtimeFor(m.id)),
      })),
    }),
  );

  /** Starts an OAuth flow. Returns the provider's address for the browser to visit. */
  app.post("/connections/:connector/start", async (c) => {
    const connector = c.req.param("connector");
    const client = deps.oauth[connector];
    if (!client || !credentials)
      return c.json({ error: "This app can't be connected on this server yet." }, 400);

    const id = deps.newId("oauth");
    const redirectUri = `${appUrl(c.req.url)}/api/connections/${connector}/callback`;
    await db.insert(schema.oauthStates).values({
      id,
      workspaceId: c.get("workspaceId"),
      userId: c.get("userId"),
      connector,
      redirectUri,
      expiresAt: new Date(deps.now().getTime() + OAUTH_TTL_MS).toISOString(),
    });
    setCookie(c, OAUTH_COOKIE, id, {
      path: "/api/connections",
      httpOnly: true,
      sameSite: "Lax",
      secure: redirectUri.startsWith("https:"),
      maxAge: OAUTH_TTL_MS / 1000,
    });
    return c.json({ url: client.authorizeUrl(id, redirectUri) });
  });

  app.delete("/connections/:connector", async (c) => {
    const connector = c.req.param("connector");
    const workspaceId = c.get("workspaceId");
    const tokens = await credentials?.tokensFor(workspaceId, connector).catch(() => undefined);
    if (tokens) await deps.oauth[connector]?.revoke?.(tokens.accessToken).catch(() => undefined);
    await db
      .delete(schema.connections)
      .where(
        and(
          eq(schema.connections.workspaceId, workspaceId),
          eq(schema.connections.connector, connector),
        ),
      );
    await audit(workspaceId, c.get("userId"), "connection.removed", connector);
    return c.json({ ok: true });
  });

  app.get("/connections", async (c) => {
    const rows = await db
      .select({
        id: schema.connections.id,
        connector: schema.connections.connector,
        label: schema.connections.label,
        status: schema.connections.status,
        scopes: schema.connections.scopes,
        createdAt: schema.connections.createdAt,
      })
      .from(schema.connections)
      .where(eq(schema.connections.workspaceId, c.get("workspaceId")));
    return c.json({ connections: rows });
  });

  // ---------- Workflows ----------

  /** Validate and render sentences without saving. Used live by the builder. */
  app.post("/workflows/preview", async (c) => {
    const body = DefinitionBody.parse(await c.req.json());
    return c.json(preview(body.definition));
  });

  app.get("/workflows", async (c) => {
    const rows = await db
      .select({ workflow: schema.workflows, definition: schema.workflowVersions.definition })
      .from(schema.workflows)
      .leftJoin(
        schema.workflowVersions,
        and(
          eq(schema.workflowVersions.workflowId, schema.workflows.id),
          eq(
            schema.workflowVersions.version,
            sql`coalesce(${schema.workflows.activeVersion}, ${schema.workflows.latestVersion})`,
          ),
        ),
      )
      .where(eq(schema.workflows.workspaceId, c.get("workspaceId")))
      .orderBy(desc(schema.workflows.updatedAt));
    const now = deps.now();
    return c.json({
      workflows: rows.map(({ workflow, definition }) => {
        const trigger = (definition as WorkflowDefinition | null)?.trigger;
        let nextRunAt: string | undefined;
        if (trigger?.kind === "schedule" && workflow.status === "running") {
          try {
            nextRunAt = nextScheduledRun(trigger, now)?.toISOString();
          } catch {
            // An invalid schedule can't be running; leave it blank if one is.
          }
        }
        return { ...workflow, trigger: trigger?.kind, nextRunAt };
      }),
    });
  });

  app.post("/workflows", async (c) => {
    const body = DefinitionBody.parse(await c.req.json());
    const id = deps.newId("wf");
    const definition =
      body.definition && typeof body.definition === "object"
        ? { ...body.definition, id, version: 1 }
        : body.definition;
    const result = preview(definition);
    const name =
      (definition as Partial<WorkflowDefinition> | undefined)?.name?.toString().slice(0, 200) ||
      "Untitled automation";
    const status: WorkflowStatus = result.ok ? "needs_review" : "draft";

    await db.insert(schema.workflows).values({
      id,
      workspaceId: c.get("workspaceId"),
      name,
      status,
      latestVersion: 1,
    });
    await db.insert(schema.workflowVersions).values({ workflowId: id, version: 1, definition });
    return c.json({ id, status, ...result }, 201);
  });

  app.get("/workflows/:id", async (c) => {
    const wf = await findWorkflow(c.get("workspaceId"), c.req.param("id"));
    if (!wf) return c.json({ error: "Not found." }, 404);
    const version = await findVersion(wf.id, wf.latestVersion);
    return c.json({
      workflow: wf,
      definition: version?.definition,
      ...preview(version?.definition),
    });
  });

  /** Every edit is a new version. The running version is untouched until approved. */
  app.put("/workflows/:id", async (c) => {
    const wf = await findWorkflow(c.get("workspaceId"), c.req.param("id"));
    if (!wf) return c.json({ error: "Not found." }, 404);
    const body = DefinitionBody.parse(await c.req.json());
    const version = wf.latestVersion + 1;
    const definition =
      body.definition && typeof body.definition === "object"
        ? { ...body.definition, id: wf.id, version }
        : body.definition;
    const result = preview(definition);

    await db.insert(schema.workflowVersions).values({ workflowId: wf.id, version, definition });
    await db
      .update(schema.workflows)
      .set({
        latestVersion: version,
        // A running workflow keeps running its approved version.
        status:
          wf.status === "running" || wf.status === "paused"
            ? wf.status
            : result.ok
              ? "needs_review"
              : "draft",
        updatedAt: deps.now().toISOString(),
      })
      .where(eq(schema.workflows.id, wf.id));
    return c.json({ id: wf.id, version, ...result });
  });

  /** Approval and activation. Never happens implicitly. */
  app.post("/workflows/:id/activate", async (c) => {
    const wf = await findWorkflow(c.get("workspaceId"), c.req.param("id"));
    if (!wf) return c.json({ error: "Not found." }, 404);
    const version = await findVersion(wf.id, wf.latestVersion);
    const result = preview(version?.definition);
    if (!result.ok)
      return c.json({ error: "This automation has problems to fix first.", ...result }, 422);

    const missing = await missingConnections(
      c.get("workspaceId"),
      version!.definition as WorkflowDefinition,
    );
    if (missing.length) {
      await db
        .update(schema.workflows)
        .set({ status: "needs_connection", updatedAt: deps.now().toISOString() })
        .where(eq(schema.workflows.id, wf.id));
      return c.json(
        { error: missing.map((m) => m.reason).join(" "), status: "needs_connection", missing },
        409,
      );
    }

    const at = deps.now().toISOString();
    await db
      .update(schema.workflowVersions)
      .set({ approvedBy: c.get("userId"), approvedAt: at })
      .where(
        and(
          eq(schema.workflowVersions.workflowId, wf.id),
          eq(schema.workflowVersions.version, wf.latestVersion),
        ),
      );
    await db
      .update(schema.workflows)
      .set({ status: "running", activeVersion: wf.latestVersion, updatedAt: at })
      .where(eq(schema.workflows.id, wf.id));
    await audit(c.get("workspaceId"), c.get("userId"), "workflow.activated", wf.id, {
      version: wf.latestVersion,
    });
    return c.json({ id: wf.id, status: "running", activeVersion: wf.latestVersion });
  });

  app.post("/workflows/:id/pause", async (c) => {
    const wf = await findWorkflow(c.get("workspaceId"), c.req.param("id"));
    if (!wf) return c.json({ error: "Not found." }, 404);
    if (wf.status !== "running")
      return c.json({ error: "Only running automations can be paused." }, 409);
    await db
      .update(schema.workflows)
      .set({ status: "paused", updatedAt: deps.now().toISOString() })
      .where(eq(schema.workflows.id, wf.id));
    await audit(c.get("workspaceId"), c.get("userId"), "workflow.paused", wf.id);
    return c.json({ id: wf.id, status: "paused" });
  });

  /** Basic export: every version, as plain JSON, runnable by the portable runner. */
  app.get("/workflows/:id/export", async (c) => {
    const wf = await findWorkflow(c.get("workspaceId"), c.req.param("id"));
    if (!wf) return c.json({ error: "Not found." }, 404);
    const versions = await db
      .select()
      .from(schema.workflowVersions)
      .where(eq(schema.workflowVersions.workflowId, wf.id))
      .orderBy(schema.workflowVersions.version);
    c.header("content-disposition", `attachment; filename="${wf.id}.json"`);
    return c.json({
      format: "tappet.workflow-export",
      formatVersion: 1,
      exportedAt: deps.now().toISOString(),
      workflow: { id: wf.id, name: wf.name, activeVersion: wf.activeVersion },
      versions: versions.map((v) => ({
        version: v.version,
        approvedAt: v.approvedAt,
        definition: v.definition,
      })),
    });
  });

  // ---------- Runs ----------

  /** Starts a run of the approved version now. For manual and scheduled automations. */
  app.post("/workflows/:id/runs", async (c) => {
    const workspaceId = c.get("workspaceId");
    const wf = await findWorkflow(workspaceId, c.req.param("id"));
    if (!wf) return c.json({ error: "Not found." }, 404);
    if (wf.status !== "running" || !wf.activeVersion)
      return c.json({ error: "Turn this automation on before running it." }, 409);
    const version = await findVersion(wf.id, wf.activeVersion);
    const def = version?.definition as WorkflowDefinition | undefined;
    // Scheduled ones can run early; event-started ones need the event's data.
    if (def?.trigger.kind !== "manual" && def?.trigger.kind !== "schedule")
      return c.json(
        { error: "This automation starts when something happens, so it can't be run by hand." },
        409,
      );
    const missing = await missingConnections(workspaceId, def);
    if (missing.length)
      return c.json({ error: missing.map((m) => m.reason).join(" "), missing }, 409);

    const body = RunBody.parse(await c.req.json().catch(() => undefined));
    const run = await runs.start({
      workspaceId,
      workflowId: wf.id,
      version: wf.activeVersion,
      trigger: body?.trigger ?? { startedBy: c.get("userId") },
      // Every press of "Run now" is its own event.
      triggerKey: deps.newId("manual"),
    });
    if (!run) throw new Error("A fresh trigger key collided.");
    await audit(workspaceId, c.get("userId"), "workflow.run", wf.id, { runId: run.id });
    return c.json({ run }, 201);
  });

  app.get("/workflows/:id/runs", async (c) => {
    const wf = await findWorkflow(c.get("workspaceId"), c.req.param("id"));
    if (!wf) return c.json({ error: "Not found." }, 404);
    const rows = await db
      .select({
        id: schema.runs.id,
        status: schema.runs.status,
        error: schema.runs.error,
        startedAt: schema.runs.startedAt,
        finishedAt: schema.runs.finishedAt,
      })
      .from(schema.runs)
      .where(eq(schema.runs.workflowId, wf.id))
      .orderBy(desc(schema.runs.startedAt))
      .limit(20);
    return c.json({ runs: rows });
  });

  // ---------- Activity ----------

  app.get("/activity", async (c) => {
    const events = await db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.workspaceId, c.get("workspaceId")))
      .orderBy(desc(schema.runEvents.at))
      .limit(50);
    return c.json({ events });
  });

  app.onError((err, c) => {
    if (err instanceof z.ZodError)
      return c.json({ error: "That request wasn't in the expected shape." }, 400);
    if (err instanceof SyntaxError)
      return c.json({ error: "That request wasn't valid JSON." }, 400);
    console.error(err);
    return c.json({ error: "Something went wrong on our side." }, 500);
  });

  return app;
}
