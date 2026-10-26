import {
  SCHEMA_VERSION,
  validateWorkflow,
  type Catalog,
  type CatalogEntry,
  type ValidationIssue,
  type WorkflowDefinition,
} from "@tappet/workflow";
import type { ModelProvider } from "./provider.js";

export type InterpretResult =
  | { kind: "draft"; definition: WorkflowDefinition; issues: ValidationIssue[] }
  | { kind: "needs_clarification"; question: string }
  | { kind: "invalid"; issues: ValidationIssue[] };

/**
 * Turns a plain-language request into a draft workflow definition.
 *
 * The result is always a draft. It is never activated from here: ambiguous
 * requests come back as a question, and valid drafts still go through review
 * and approval in the builder.
 */
export async function interpretAutomationRequest(
  provider: ModelProvider,
  request: string,
  available: CatalogEntry[],
  catalog: Catalog,
  ids: { workflowId: string },
): Promise<InterpretResult> {
  const system = [
    "You turn a small-business owner's request into a workflow definition.",
    `Reply with one JSON object: either {"question": "..."} if the request is ambiguous,`,
    `or {"workflow": <definition>} using schemaVersion ${SCHEMA_VERSION}.`,
    "Use only these events and actions:",
    ...available.map((e) => `- ${e.kind} ${e.connector}.${e.name}: ${e.phrase}`),
    "Loops must set maxItems. Repeats must set maxTimes and stopWhen.",
  ].join("\n");

  const reply = await provider.complete({
    system,
    messages: [{ role: "user", content: request }],
    maxTokens: 2000,
    json: true,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.text);
  } catch {
    return {
      kind: "needs_clarification",
      question: "Sorry, I didn't follow that. Could you put it another way?",
    };
  }

  if (parsed && typeof parsed === "object" && "question" in parsed) {
    return { kind: "needs_clarification", question: String(parsed.question) };
  }

  const candidate =
    parsed && typeof parsed === "object" && "workflow" in parsed ? parsed.workflow : undefined;
  // The model doesn't choose ids or versions.
  const withIds =
    candidate && typeof candidate === "object"
      ? { ...candidate, id: ids.workflowId, version: 1, schemaVersion: SCHEMA_VERSION }
      : candidate;

  const result = validateWorkflow(withIds, catalog);
  return result.ok
    ? { kind: "draft", definition: result.definition, issues: result.issues }
    : { kind: "invalid", issues: result.issues };
}
