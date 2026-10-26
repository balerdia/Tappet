import type { Catalog } from "./catalog.js";
import { refsInCondition, refsInValue } from "./expressions.js";
import { WorkflowDefinitionSchema, type Step, type WorkflowDefinition } from "./schema.js";

export type ValidationIssue = {
  severity: "error" | "warning";
  /** Step id the issue relates to, or "trigger" / "definition". */
  at: string;
  message: string;
};

export type ValidationResult =
  | { ok: true; definition: WorkflowDefinition; issues: ValidationIssue[] }
  | { ok: false; issues: ValidationIssue[] };

const RESERVED_NAMES = new Set(["trigger", "steps"]);

/**
 * Checks a definition before it can be saved as ready or activated.
 * Structural checks come from the schema; the rest catch combinations the
 * builder should never allow: unknown references, unreachable steps,
 * sensitive actions without approval, and so on.
 */
export function validateWorkflow(input: unknown, catalog?: Catalog): ValidationResult {
  const parsed = WorkflowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        severity: "error",
        at: i.path.length ? i.path.join(".") : "definition",
        message: i.message,
      })),
    };
  }

  const definition = parsed.data;
  const issues: ValidationIssue[] = [];
  const seenIds = new Set<string>();

  const trigger = definition.trigger;
  if (trigger.kind === "event") {
    if (catalog && !catalog.find(trigger.connector, trigger.event, "event")) {
      issues.push({
        severity: "error",
        at: "trigger",
        message: `${trigger.connector} has no event called "${trigger.event}".`,
      });
    }
    if (trigger.filter) checkRefs(refsInCondition(trigger.filter), "trigger", new Set(), new Set());
  }

  function checkRefs(refs: string[], at: string, visibleSteps: Set<string>, vars: Set<string>) {
    for (const ref of refs) {
      const [head, second] = ref.split(".");
      if (head === "trigger") continue;
      if (head === "steps") {
        if (!second || !visibleSteps.has(second)) {
          issues.push({
            severity: "error",
            at,
            message: `"${ref}" refers to a step that hasn't happened yet or doesn't exist.`,
          });
        }
        continue;
      }
      if (head && vars.has(head)) continue;
      issues.push({ severity: "error", at, message: `"${ref}" doesn't refer to anything.` });
    }
  }

  // Walks a block in execution order. Returns the action ids it produced so
  // later siblings can reference them. Loop bodies don't leak ids outward.
  function walk(
    steps: Step[],
    visible: Set<string>,
    vars: Set<string>,
    approved: boolean,
  ): Set<string> {
    const produced = new Set(visible);
    let approvedSoFar = approved;

    steps.forEach((step, index) => {
      if (seenIds.has(step.id)) {
        issues.push({
          severity: "error",
          at: step.id,
          message: `Step id "${step.id}" is used twice.`,
        });
      }
      seenIds.add(step.id);

      if (step.kind === "stop" && index < steps.length - 1) {
        issues.push({
          severity: "error",
          at: step.id,
          message: "Nothing after a stop will ever run. Move or remove the later steps.",
        });
      }

      switch (step.kind) {
        case "action": {
          checkRefs(Object.values(step.input).flatMap(refsInValue), step.id, produced, vars);
          const entry = catalog?.find(step.connector, step.action, "action");
          if (catalog && !entry) {
            issues.push({
              severity: "error",
              at: step.id,
              message: `${step.connector} has no action called "${step.action}".`,
            });
          }
          for (const name of entry?.requiredInputs ?? []) {
            if (!(name in step.input)) {
              issues.push({ severity: "error", at: step.id, message: `Missing "${name}".` });
            }
          }
          if (entry?.sensitive && !step.requiresApproval && !approvedSoFar) {
            issues.push({
              severity: "error",
              at: step.id,
              message: `"${entry.phrase}" needs approval before it runs.`,
            });
          }
          produced.add(step.id);
          break;
        }
        case "if": {
          checkRefs(refsInCondition(step.condition), step.id, produced, vars);
          const a = walk(step.then, produced, vars, approvedSoFar);
          const b = walk(step.otherwise ?? [], produced, vars, approvedSoFar);
          for (const id of [...a, ...b]) produced.add(id);
          break;
        }
        case "forEach": {
          checkRefs(refsInValue(step.collection), step.id, produced, vars);
          if (RESERVED_NAMES.has(step.as) || vars.has(step.as)) {
            issues.push({
              severity: "error",
              at: step.id,
              message: `"${step.as}" is already in use. Pick another name for each item.`,
            });
          }
          walk(step.steps, produced, new Set([...vars, step.as]), approvedSoFar);
          walk(step.ifEmpty ?? [], produced, vars, approvedSoFar);
          break;
        }
        case "repeat": {
          const inner = walk(step.steps, produced, vars, approvedSoFar);
          // stopWhen is checked before each round, so it may read the
          // previous round's outputs.
          checkRefs(refsInCondition(step.stopWhen), step.id, inner, vars);
          break;
        }
        case "wait":
          if (step.until.kind === "time") {
            checkRefs(refsInValue(step.until.at), step.id, produced, vars);
          }
          break;
        case "approval":
          approvedSoFar = true;
          break;
        case "stop":
          break;
      }
    });

    return produced;
  }

  walk(definition.steps, new Set(), new Set(), false);

  const hasErrors = issues.some((i) => i.severity === "error");
  return hasErrors ? { ok: false, issues } : { ok: true, definition, issues };
}
