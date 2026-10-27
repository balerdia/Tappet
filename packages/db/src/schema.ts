import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// One schema for every deployment: SQLite/libSQL for Node and Docker, D1 on
// Cloudflare. Timestamps are ISO strings so exports read cleanly.

const createdAt = () =>
  text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  /** The sign-in provider's id for this person (Clerk's `sub`). Null for the dev user. */
  authSubject: text("auth_subject").unique(),
  createdAt: createdAt(),
});

export const memberships = sqliteTable(
  "memberships",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const connections = sqliteTable(
  "connections",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connector: text("connector").notNull(),
    label: text("label").notNull(),
    status: text("status", { enum: ["connected", "needs_reauth", "revoked"] }).notNull(),
    /** AES-GCM ciphertext. Never returned by the API. */
    encryptedCredentials: text("encrypted_credentials"),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull().default([]),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("connections_workspace_idx").on(t.workspaceId),
    // One connection per app per workspace for now. Reconnecting replaces it.
    uniqueIndex("connections_workspace_connector_idx").on(t.workspaceId, t.connector),
  ],
);

/**
 * In-flight OAuth sign-ins. The id is the `state` sent to the provider and is
 * also set as a cookie, so a callback only completes in the browser that
 * started it. Rows are single-use and expire after a few minutes.
 */
export const oauthStates = sqliteTable("oauth_states", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  connector: text("connector").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: createdAt(),
});

export const workflows = sqliteTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status", {
      enum: [
        "draft",
        "needs_connection",
        "needs_review",
        "ready",
        "running",
        "paused",
        "needs_attention",
        "completed",
        "failed",
      ],
    }).notNull(),
    /** The version that runs. Null until something is approved. */
    activeVersion: integer("active_version"),
    latestVersion: integer("latest_version").notNull(),
    createdAt: createdAt(),
    updatedAt: createdAt(),
  },
  (t) => [index("workflows_workspace_idx").on(t.workspaceId)],
);

/** Definitions are immutable once written. Edits create a new version. */
export const workflowVersions = sqliteTable(
  "workflow_versions",
  {
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    definition: text("definition", { mode: "json" }).notNull(),
    approvedBy: text("approved_by").references(() => users.id),
    approvedAt: text("approved_at"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workflowId, t.version] })],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    workflowVersion: integer("workflow_version").notNull(),
    status: text("status", {
      enum: ["running", "waiting", "awaiting_approval", "completed", "failed"],
    }).notNull(),
    /** Serialised RunState from @tappet/workflow. */
    state: text("state", { mode: "json" }).notNull(),
    /** Identifies the triggering event so the same event can't start two runs. */
    triggerKey: text("trigger_key").notNull(),
    wakeAt: text("wake_at"),
    error: text("error"),
    startedAt: createdAt(),
    finishedAt: text("finished_at"),
  },
  (t) => [
    uniqueIndex("runs_trigger_key_idx").on(t.workflowId, t.triggerKey),
    index("runs_wake_idx").on(t.status, t.wakeAt),
  ],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    at: text("at").notNull(),
    path: text("path").notNull(),
    type: text("type").notNull(),
    message: text("message").notNull(),
  },
  (t) => [index("run_events_workspace_idx").on(t.workspaceId, t.at)],
);

/** Organise: saved, refreshable views. */
export const savedViews = sqliteTable("saved_views", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  question: text("question").notNull(),
  sources: text("sources", { mode: "json" }).$type<string[]>().notNull(),
  createdBy: text("created_by").references(() => users.id),
  createdAt: createdAt(),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: text("workspace_id").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    subject: text("subject").notNull(),
    detail: text("detail", { mode: "json" }),
    at: createdAt(),
  },
  (t) => [index("audit_workspace_idx").on(t.workspaceId, t.at)],
);
