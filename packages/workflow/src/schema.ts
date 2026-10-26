import { z } from "zod";

/**
 * The workflow definition is the single source of truth for an automation.
 * The sentence builder and natural-language editing both produce and edit this
 * structure; the runner executes it. There is no second execution model.
 *
 * Sentence phrase → definition:
 *   When…               trigger
 *   If… / Otherwise…    { kind: "if", then, otherwise }
 *   And / Or…           { op: "and" | "or" } conditions
 *   Then…               { kind: "action" }
 *   For each…           { kind: "forEach" }
 *   If nothing is found { kind: "forEach", ifEmpty }
 *   Wait until…         { kind: "wait" }
 *   Keep doing until…   { kind: "repeat", stopWhen, maxTimes }
 *   Stop when…          { kind: "repeat", stopWhen } or { kind: "stop" }
 */

export const SCHEMA_VERSION = 1 as const;

// ---------- Values ----------

/** A value is a reference into run data, a literal, or a text template. */
export type Value =
  { ref: string } | { literal: string | number | boolean | null } | { template: string };

export const ValueSchema: z.ZodType<Value> = z.union([
  z.object({ ref: z.string().min(1) }).strict(),
  z.object({ literal: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict(),
  z.object({ template: z.string() }).strict(),
]);

// ---------- Conditions ----------

export type CompareOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains";
export type UnaryOp = "exists" | "isEmpty";

export type Condition =
  | { op: "and" | "or"; conditions: Condition[] }
  | { op: "not"; condition: Condition }
  | { op: CompareOp; left: Value; right: Value }
  | { op: UnaryOp; value: Value };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(["and", "or"]), conditions: z.array(ConditionSchema).min(1) }).strict(),
    z.object({ op: z.literal("not"), condition: ConditionSchema }).strict(),
    z
      .object({
        op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains"]),
        left: ValueSchema,
        right: ValueSchema,
      })
      .strict(),
    z.object({ op: z.enum(["exists", "isEmpty"]), value: ValueSchema }).strict(),
  ]),
);

// ---------- Triggers ----------

export type Trigger =
  | { kind: "event"; connector: string; event: string; filter?: Condition }
  | { kind: "schedule"; cron: string; timezone: string }
  | { kind: "webhook" }
  | { kind: "manual" };

export const TriggerSchema: z.ZodType<Trigger> = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("event"),
      connector: z.string().min(1),
      event: z.string().min(1),
      filter: ConditionSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("schedule"),
      cron: z.string().min(1),
      timezone: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("webhook") }).strict(),
  z.object({ kind: z.literal("manual") }).strict(),
]);

// ---------- Steps ----------

export type RetryPolicy = { maxAttempts: number; backoffMs: number };

export type WaitFor =
  | { kind: "duration"; ms: number }
  | { kind: "time"; at: Value }
  | { kind: "event"; connector: string; event: string; timeoutMs: number };

export type Step =
  | {
      kind: "action";
      id: string;
      connector: string;
      action: string;
      input: Record<string, Value>;
      requiresApproval?: boolean;
      retry?: RetryPolicy;
    }
  | { kind: "if"; id: string; condition: Condition; then: Step[]; otherwise?: Step[] }
  | {
      kind: "forEach";
      id: string;
      collection: Value;
      as: string;
      maxItems: number;
      steps: Step[];
      ifEmpty?: Step[];
    }
  | { kind: "wait"; id: string; until: WaitFor }
  | {
      kind: "repeat";
      id: string;
      everyMs: number;
      maxTimes: number;
      stopWhen: Condition;
      steps: Step[];
    }
  | { kind: "approval"; id: string; message: string }
  | { kind: "stop"; id: string; reason?: string };

const StepId = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "Step ids are letters, numbers and underscores");

const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10),
    backoffMs: z.number().int().min(0),
  })
  .strict();

const WaitForSchema: z.ZodType<WaitFor> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("duration"), ms: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("time"), at: ValueSchema }).strict(),
  z
    .object({
      kind: z.literal("event"),
      connector: z.string().min(1),
      event: z.string().min(1),
      timeoutMs: z.number().int().positive(),
    })
    .strict(),
]);

export const StepSchema: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("action"),
        id: StepId,
        connector: z.string().min(1),
        action: z.string().min(1),
        input: z.record(z.string(), ValueSchema),
        requiresApproval: z.boolean().optional(),
        retry: RetryPolicySchema.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("if"),
        id: StepId,
        condition: ConditionSchema,
        then: z.array(StepSchema).min(1),
        otherwise: z.array(StepSchema).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("forEach"),
        id: StepId,
        collection: ValueSchema,
        as: StepId,
        // Loops are always bounded.
        maxItems: z.number().int().min(1).max(10_000),
        steps: z.array(StepSchema).min(1),
        ifEmpty: z.array(StepSchema).optional(),
      })
      .strict(),
    z.object({ kind: z.literal("wait"), id: StepId, until: WaitForSchema }).strict(),
    z
      .object({
        kind: z.literal("repeat"),
        id: StepId,
        everyMs: z.number().int().positive(),
        maxTimes: z.number().int().min(1).max(1_000),
        stopWhen: ConditionSchema,
        steps: z.array(StepSchema).min(1),
      })
      .strict(),
    z.object({ kind: z.literal("approval"), id: StepId, message: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("stop"), id: StepId, reason: z.string().optional() }).strict(),
  ]),
);

// ---------- Definition ----------

export type WorkflowDefinition = {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  version: number;
  name: string;
  description?: string;
  trigger: Trigger;
  steps: Step[];
};

export const WorkflowDefinitionSchema: z.ZodType<WorkflowDefinition> = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string().min(1),
    version: z.number().int().min(1),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    trigger: TriggerSchema,
    steps: z.array(StepSchema).min(1),
  })
  .strict();
