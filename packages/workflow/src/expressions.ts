import type { Condition, Value } from "./schema.js";

/**
 * Run data visible to a step: the trigger payload, outputs of earlier steps,
 * and any loop variables in scope.
 */
export type Scope = {
  trigger: unknown;
  steps: Record<string, unknown>;
  vars: Record<string, unknown>;
};

const TEMPLATE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

export function resolvePath(scope: Scope, path: string): unknown {
  const [head, ...rest] = path.split(".");
  let current: unknown;
  if (head === "trigger") current = scope.trigger;
  else if (head === "steps") current = scope.steps;
  else if (head !== undefined && head in scope.vars) current = scope.vars[head];
  else return undefined;

  for (const key of rest) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function resolveValue(scope: Scope, value: Value): unknown {
  if ("ref" in value) return resolvePath(scope, value.ref);
  if ("literal" in value) return value.literal;
  return value.template.replace(TEMPLATE_PATTERN, (_, path: string) => {
    const resolved = resolvePath(scope, path);
    return resolved === undefined || resolved === null ? "" : String(resolved);
  });
}

/** Every ref path a value reads, including those inside templates. */
export function refsInValue(value: Value): string[] {
  if ("ref" in value) return [value.ref];
  if ("template" in value) return [...value.template.matchAll(TEMPLATE_PATTERN)].map((m) => m[1]!);
  return [];
}

export function refsInCondition(condition: Condition): string[] {
  switch (condition.op) {
    case "and":
    case "or":
      return condition.conditions.flatMap(refsInCondition);
    case "not":
      return refsInCondition(condition.condition);
    case "exists":
    case "isEmpty":
      return refsInValue(condition.value);
    default:
      return [...refsInValue(condition.left), ...refsInValue(condition.right)];
  }
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

export function evaluateCondition(scope: Scope, condition: Condition): boolean {
  switch (condition.op) {
    case "and":
      return condition.conditions.every((c) => evaluateCondition(scope, c));
    case "or":
      return condition.conditions.some((c) => evaluateCondition(scope, c));
    case "not":
      return !evaluateCondition(scope, condition.condition);
    case "exists":
      return resolveValue(scope, condition.value) !== undefined;
    case "isEmpty":
      return isEmpty(resolveValue(scope, condition.value));
  }

  const left = resolveValue(scope, condition.left);
  const right = resolveValue(scope, condition.right);
  switch (condition.op) {
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    case "contains":
      if (typeof left === "string") return left.includes(String(right));
      if (Array.isArray(left)) return left.includes(right);
      return false;
    default: {
      // Ordering comparisons only make sense on two numbers or two strings.
      if (typeof left !== typeof right || (typeof left !== "number" && typeof left !== "string")) {
        return false;
      }
      const l = left as number | string;
      const r = right as number | string;
      if (condition.op === "gt") return l > r;
      if (condition.op === "gte") return l >= r;
      if (condition.op === "lt") return l < r;
      return l <= r;
    }
  }
}
