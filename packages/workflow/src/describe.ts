import type { Catalog } from "./catalog.js";
import type { Condition, Step, Trigger, Value, WaitFor, WorkflowDefinition } from "./schema.js";

export type Phrase =
  | "When"
  | "If"
  | "Then"
  | "Otherwise"
  | "For each"
  | "If nothing is found"
  | "Wait until"
  | "Wait for"
  | "Keep doing this until"
  | "Ask for approval"
  | "Stop";

export type SentenceLine = {
  /** Step id, or "trigger" for the opening line. */
  at: string;
  depth: number;
  phrase: Phrase;
  text: string;
};

/**
 * Renders a definition as the readable sentences a person sees in the builder
 * and in previews. This is a pure view of the definition: editing a sentence
 * edits the definition, never the text.
 */
export function describeWorkflow(def: WorkflowDefinition, catalog?: Catalog): SentenceLine[] {
  const lines: SentenceLine[] = [
    { at: "trigger", depth: 0, phrase: "When", text: describeTrigger(def.trigger, catalog) },
  ];
  pushSteps(lines, def.steps, 0, catalog);
  return lines;
}

/** One plain-text paragraph, handy for summaries and notifications. */
export function describeWorkflowAsText(def: WorkflowDefinition, catalog?: Catalog): string {
  return describeWorkflow(def, catalog)
    .map((l) => `${"  ".repeat(l.depth)}${l.phrase} ${l.text}`.trimEnd())
    .join("\n");
}

function pushSteps(lines: SentenceLine[], steps: Step[], depth: number, catalog?: Catalog) {
  for (const step of steps) {
    switch (step.kind) {
      case "action": {
        const entry = catalog?.find(step.connector, step.action, "action");
        const text = entry?.phrase ?? `${words(step.action)} in ${step.connector}`;
        lines.push({ at: step.id, depth, phrase: "Then", text });
        break;
      }
      case "if":
        lines.push({ at: step.id, depth, phrase: "If", text: describeCondition(step.condition) });
        pushSteps(lines, step.then, depth + 1, catalog);
        if (step.otherwise?.length) {
          lines.push({ at: step.id, depth, phrase: "Otherwise", text: "" });
          pushSteps(lines, step.otherwise, depth + 1, catalog);
        }
        break;
      case "forEach":
        lines.push({
          at: step.id,
          depth,
          phrase: "For each",
          text: `${words(step.as)} in ${describeValue(step.collection)} (up to ${step.maxItems})`,
        });
        pushSteps(lines, step.steps, depth + 1, catalog);
        if (step.ifEmpty?.length) {
          lines.push({ at: step.id, depth, phrase: "If nothing is found", text: "" });
          pushSteps(lines, step.ifEmpty, depth + 1, catalog);
        }
        break;
      case "wait":
        lines.push({ at: step.id, depth, ...describeWait(step.until) });
        break;
      case "repeat":
        lines.push({
          at: step.id,
          depth,
          phrase: "Keep doing this until",
          text: `${describeCondition(step.stopWhen)}, every ${describeDuration(step.everyMs)}, at most ${step.maxTimes} times`,
        });
        pushSteps(lines, step.steps, depth + 1, catalog);
        break;
      case "approval":
        lines.push({ at: step.id, depth, phrase: "Ask for approval", text: step.message });
        break;
      case "stop":
        lines.push({ at: step.id, depth, phrase: "Stop", text: step.reason ?? "" });
        break;
    }
  }
}

function describeTrigger(trigger: Trigger, catalog?: Catalog): string {
  switch (trigger.kind) {
    case "event": {
      const entry = catalog?.find(trigger.connector, trigger.event, "event");
      const base = entry?.phrase ?? `${words(trigger.event)} in ${trigger.connector}`;
      return trigger.filter ? `${base}, and ${describeCondition(trigger.filter)}` : base;
    }
    case "schedule":
      return describeCron(trigger.cron);
    case "webhook":
      return "a message arrives at this automation's web address";
    case "manual":
      return "you run it";
  }
}

function describeWait(until: WaitFor): { phrase: Phrase; text: string } {
  switch (until.kind) {
    case "duration":
      return { phrase: "Wait for", text: describeDuration(until.ms) };
    case "time":
      return { phrase: "Wait until", text: describeValue(until.at) };
    case "event":
      return {
        phrase: "Wait until",
        text: `${words(until.event)} in ${until.connector} (give up after ${describeDuration(until.timeoutMs)})`,
      };
  }
}

export function describeCondition(c: Condition): string {
  switch (c.op) {
    case "and":
      return c.conditions.map(describeCondition).join(" and ");
    case "or":
      return c.conditions.map(describeCondition).join(" or ");
    case "not":
      return `not (${describeCondition(c.condition)})`;
    case "exists":
      return `${describeValue(c.value)} has a value`;
    case "isEmpty":
      return `${describeValue(c.value)} is empty`;
  }
  const verbs: Record<typeof c.op, string> = {
    eq: "is",
    neq: "is not",
    gt: "is more than",
    gte: "is at least",
    lt: "is less than",
    lte: "is at most",
    contains: "contains",
  };
  if (c.op === "eq" && "literal" in c.right && c.right.literal === true) {
    return describeValue(c.left);
  }
  return `${describeValue(c.left)} ${verbs[c.op]} ${describeValue(c.right)}`;
}

function describeValue(v: Value): string {
  if ("literal" in v) return typeof v.literal === "string" ? `"${v.literal}"` : String(v.literal);
  if ("template" in v) return `"${v.template}"`;
  const parts = v.ref.split(".");
  // steps.findTasks.items → "items from find tasks"
  if (parts[0] === "steps" && parts.length > 2) {
    return `${words(parts.slice(2).join(" "))} from ${words(parts[1]!)}`;
  }
  const meaningful = parts[0] === "trigger" || parts[0] === "steps" ? parts.slice(1) : parts;
  return words(meaningful.join(" ")) || "the trigger";
}

function words(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.]/g, " ")
    .toLowerCase()
    .trim();
}

export function describeDuration(ms: number): string {
  const units: [number, string][] = [
    [7 * 24 * 3_600_000, "week"],
    [24 * 3_600_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
    [1_000, "second"],
  ];
  for (const [size, name] of units) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size;
      return n === 1 ? `1 ${name}` : `${n} ${name}s`;
    }
  }
  return `${ms} ms`;
}

function describeCron(cron: string): string {
  const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/);
  const simpleTime = /^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "");
  const time = simpleTime ? `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}` : "";
  if (simpleTime && dom === "*" && month === "*") {
    if (dow === "*") return `every day at ${time}`;
    if (dow === "1-5") return `every weekday at ${time}`;
  }
  if (minute === "0" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return "every hour";
  }
  return `on the schedule "${cron}"`;
}

/** Every connector a workflow needs, in the order they first appear. */
export function connectorsUsed(def: WorkflowDefinition): string[] {
  const found = new Set<string>();
  if (def.trigger.kind === "event") found.add(def.trigger.connector);
  const visit = (steps: Step[]) => {
    for (const s of steps) {
      if (s.kind === "action") found.add(s.connector);
      if (s.kind === "wait" && s.until.kind === "event") found.add(s.until.connector);
      if (s.kind === "if") visit([...s.then, ...(s.otherwise ?? [])]);
      if (s.kind === "forEach") visit([...s.steps, ...(s.ifEmpty ?? [])]);
      if (s.kind === "repeat") visit(s.steps);
    }
  };
  visit(def.steps);
  return [...found];
}
