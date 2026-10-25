import type { SourceRecord } from "@tappet/connectors";
import { evidenceFrom, type Commitment, type Finding } from "./types.js";

/**
 * The proof-of-concept check: which commitments have no task covering them?
 *
 * This is a deterministic baseline using word overlap. It is deliberately
 * cautious: a weak match is reported as "uncertain" for a person to check
 * rather than silently treated as covered. A model-based matcher can replace
 * `score` later without changing the shape of the findings.
 */
export type CoverageOptions = {
  /** At or above this, the commitment counts as covered. */
  coveredAt?: number;
  /** Between this and `coveredAt`, the match is shown as uncertain. */
  uncertainAt?: number;
  now?: Date;
};

const STOP_WORDS = new Set(
  "a an and are as at be by for from has have i in is it of on or our so that the this to we will with you your".split(
    " ",
  ),
);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

export function score(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

export function findUncoveredCommitments(
  commitments: Commitment[],
  tasks: SourceRecord[],
  options: CoverageOptions = {},
): Finding[] {
  const coveredAt = options.coveredAt ?? 0.6;
  const uncertainAt = options.uncertainAt ?? 0.3;
  const retrievedAt = (options.now ?? new Date()).toISOString();
  const findings: Finding[] = [];

  for (const c of commitments) {
    let best: { task: SourceRecord; score: number } | undefined;
    for (const task of tasks) {
      const s = score(c.text, `${task.title} ${task.text}`);
      if (!best || s > best.score) best = { task, score: s };
    }

    if (best && best.score >= coveredAt) continue;

    const evidence = [evidenceFrom(c.source, c.excerpt, retrievedAt)];
    if (best && best.score >= uncertainAt) {
      findings.push({
        id: `coverage:${c.id}`,
        kind: "missing_task",
        summary: `"${c.text}" might be covered by "${best.task.title}". Please check.`,
        certainty: "uncertain",
        evidence: [...evidence, evidenceFrom(best.task, best.task.title, retrievedAt)],
        relatedRecordIds: [c.source.id, best.task.id],
      });
    } else {
      findings.push({
        id: `coverage:${c.id}`,
        kind: "missing_task",
        summary: `No task covers "${c.text}".`,
        certainty: "inferred",
        evidence,
        relatedRecordIds: [c.source.id],
      });
    }
  }

  return findings;
}
