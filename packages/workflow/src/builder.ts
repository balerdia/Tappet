import { SCHEMA_VERSION, type Step, type Trigger, type WorkflowDefinition } from "./schema.js";

/**
 * What the sentence builder collects: one "When" and a list of "Then"s,
 * each a plain choice with a few blanks. `buildWorkflow` turns it into a
 * normal definition, which is then validated and described like any other.
 */
export type BuilderWhen =
  | { kind: "manual" }
  | {
      kind: "daily" | "weekdays" | "weekly";
      /** 24-hour "HH:MM", in `timezone`. */
      time: string;
      /** 0 = Sunday. Only for weekly. */
      day?: number;
      timezone: string;
    };

export type BuilderStep =
  | { kind: "linearTask"; title: string; description?: string }
  | { kind: "webRequest"; method: "GET" | "POST"; url: string; message?: string }
  | { kind: "approval"; message: string }
  | { kind: "wait"; amount: number; unit: "minutes" | "hours" | "days" };

export type BuilderSpec = { name: string; when: BuilderWhen; steps: BuilderStep[] };

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

function trigger(when: BuilderWhen): Trigger {
  if (when.kind === "manual") return { kind: "manual" };
  const [h, m] = when.time.split(":").map((n) => Number.parseInt(n, 10));
  const hour = Number.isFinite(h) ? h : 9;
  const minute = Number.isFinite(m) ? m : 0;
  const days =
    when.kind === "weekdays" ? "1-5" : when.kind === "weekly" ? String(when.day ?? 1) : "*";
  return { kind: "schedule", cron: `${minute} ${hour} * * ${days}`, timezone: when.timezone };
}

function step(s: BuilderStep, id: string): Step {
  switch (s.kind) {
    case "linearTask":
      return {
        kind: "action",
        id,
        connector: "linear",
        action: "createIssue",
        input: {
          title: { template: s.title },
          ...(s.description ? { description: { template: s.description } } : {}),
        },
      };
    case "webRequest":
      return {
        kind: "action",
        id,
        connector: "http",
        action: "request",
        input: {
          method: { literal: s.method },
          url: { literal: s.url },
          ...(s.method === "POST" && s.message ? { body: { template: s.message } } : {}),
        },
        retry: { maxAttempts: 3, backoffMs: 60_000 },
      };
    case "approval":
      return { kind: "approval", id, message: s.message };
    case "wait":
      return {
        kind: "wait",
        id,
        until: { kind: "duration", ms: Math.max(1, Math.round(s.amount)) * UNIT_MS[s.unit] },
      };
  }
}

export function buildWorkflow(spec: BuilderSpec): WorkflowDefinition {
  return {
    schemaVersion: SCHEMA_VERSION,
    // The server assigns the real id and version when it's saved.
    id: "wf_draft",
    version: 1,
    name: spec.name.trim() || "Untitled automation",
    trigger: trigger(spec.when),
    steps: spec.steps.map((s, i) => step(s, `step${i + 1}`)),
  };
}

/** Blanks the person still has to fill in, in plain words. Empty when it's ready to save. */
export function builderProblems(spec: BuilderSpec): string[] {
  const problems: string[] = [];
  if (!spec.name.trim()) problems.push("Give it a name.");
  if (spec.when.kind !== "manual" && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(spec.when.time)) {
    problems.push("Pick a time.");
  }
  if (!spec.steps.length) problems.push("Add at least one step.");
  spec.steps.forEach((s, i) => {
    const at = `Step ${i + 1}: `;
    if (s.kind === "linearTask" && !s.title.trim()) problems.push(`${at}give the task a title.`);
    if (s.kind === "webRequest" && !/^https:\/\/[^\s/]+/.test(s.url.trim())) {
      problems.push(`${at}the address must start with https://.`);
    }
    if (s.kind === "approval" && !s.message.trim())
      problems.push(`${at}write the question to ask.`);
    if (s.kind === "wait" && !(s.amount >= 1)) {
      problems.push(`${at}wait at least 1 ${s.unit.slice(0, -1)}.`);
    }
  });
  return problems;
}
