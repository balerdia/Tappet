import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq, schema, type Database } from "@tappet/db";
import type { ConnectorManifest } from "@tappet/connectors";
import { resolveMember, type Authenticator } from "./auth.js";
import { registerConnectionRoutes } from "./connections.js";
import type { ConnectConfig } from "./credentials.js";
import { registerRunRoutes } from "./run-routes.js";
import { ACTIVE_STATUSES } from "./runner/runs.js";
import {
  describeWorkflow,
  validateWorkflow,
  type Catalog,
  type WorkflowDefinition,
  type WorkflowStatus,
} from "@tappet/workflow";

export type AppDeps = {
  db: Database;
  catalog: Catalog;
  manifests: ConnectorManifest[];
  now: () => Date;
  newId: (prefix: string) => string;
  /** Without one, every route except /api/health returns 401. */
  auth?: Authenticator;
  /** Without one, apps can't be connected. */
  connect?: ConnectConfig;
};

export type AppEnv = { Variables: { userId: string; workspaceId: string } };

const DefinitionBody = z.object({ definition: z.unknown() });

export function createApp(deps: AppDeps) {
  const { db } = deps;
  const app = new Hono<AppEnv>().basePath("/api");

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("*", async (c, next) => {
    const subject = deps.auth ? await deps.auth.verify(c.req.raw).catch(() => null) : null;
    if (!deps.auth || !subject) return c.json({ error: "Please sign in." }, 401);
    const member = await resolveMember(db, deps.auth, subject, deps.newId);
    c.set("userId", member.userId);
    c.set("workspaceId", member.workspaceId);
    await next();
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

  registerConnectionRoutes(app, deps, audit);

  // ---------- Runs ----------

  registerRunRoutes(app, deps, audit);

  // ---------- Workflows ----------

  /** Validate and render sentences without saving. Used live by the builder. */
  app.post("/workflows/preview", async (c) => {
    const body = DefinitionBody.parse(await c.req.json());
    return c.json(preview(body.definition));
  });

  app.get("/workflows", async (c) => {
    const rows = await db
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.workspaceId, c.get("workspaceId")))
      .orderBy(desc(schema.workflows.updatedAt));
    return c.json({ workflows: rows });
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
      // Scheduling starts from now: approving never fires missed past slots.
      .set({
        status: "running",
        activeVersion: wf.latestVersion,
        updatedAt: at,
        lastScheduledAt: at,
      })
      .where(eq(schema.workflows.id, wf.id));
    await audit(c.get("workspaceId"), c.get("userId"), "workflow.activated", wf.id, {
      version: wf.latestVersion,
    });
    return c.json({ id: wf.id, status: "running", activeVersion: wf.latestVersion });
  });

  app.post("/workflows/:id/pause", async (c) => {
    const wf = await findWorkflow(c.get("workspaceId"), c.req.param("id"));
    if (!wf) return c.json({ error: "Not found." }, 404);
    if (!ACTIVE_STATUSES.has(wf.status)) {
      return c.json({ error: "Only running automations can be paused." }, 409);
    }
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
