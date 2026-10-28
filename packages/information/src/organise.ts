import type { SourceRecord } from "@tappet/connectors";
import { evidenceFrom, type Evidence, type Finding } from "./types.js";

/**
 * Answers a question from records the connectors already fetched. Read-only
 * and deterministic: every finding is a fact stated in a source (due dates,
 * owners, status) or a clearly marked guess (possible duplicates), and each
 * one links back to the records it came from.
 */
export type OrganiseResult = {
  /** One plain sentence about what was found. */
  summary: string;
  /** The words the question was matched on. Empty means "everything open". */
  keywords: string[];
  findings: Finding[];
  /** Matching records, best first. */
  matches: Evidence[];
};

// Words that say what kind of answer is wanted rather than what it's about.
const INTENT = new Set(
  "outstanding overdue late due deadline deadlines open left todo pending unfinished remaining still need needs needed done finished status progress happening going".split(
    " ",
  ),
);
const STOP = new Set(
  "the and for with what whats which who whom whose when where why how are was were is be been being has have had our ours your yours their this that these those there here about from into onto over under any all some can could should would will shall did does doing get got let lets make made more most much many not just than then them they its out off per via one two tell show give find list me my we us you anything something everything else right now today week work works task tasks thing things".split(
    " ",
  ),
);

export function keywordsOf(question: string): string[] {
  const words = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !INTENT.has(w));
  return [...new Set(words)];
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const dayMonth = (iso: string) => {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
};
const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

function score(record: SourceRecord, keywords: string[]) {
  const title = record.title.toLowerCase();
  const text = record.text.toLowerCase();
  return keywords.reduce((n, k) => n + (title.includes(k) ? 3 : 0) + (text.includes(k) ? 1 : 0), 0);
}

const titleWords = (r: SourceRecord) =>
  new Set(
    r.title
      .toLowerCase()
      // Drop the "ENG-12" style identifier so it doesn't count as a word.
      .replace(/^[a-z]+-\d+\s+/, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );

export function organise(opts: {
  question: string;
  records: SourceRecord[];
  /** Today's date where the business is, YYYY-MM-DD. */
  today: string;
  retrievedAt: string;
}): OrganiseResult {
  const { today, retrievedAt } = opts;
  const keywords = keywordsOf(opts.question);

  // One copy of each record, best match first.
  const unique = [...new Map(opts.records.map((r) => [`${r.connector}:${r.id}`, r])).values()];
  const scored = unique
    .map((record) => ({ record, score: keywords.length ? score(record, keywords) : 1 }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt));
  const relevant = scored.map((s) => s.record);

  const evidence = (r: SourceRecord) =>
    evidenceFrom(r, r.text.length > 240 ? `${r.text.slice(0, 237)}...` : r.text, retrievedAt);
  const findings: Finding[] = [];
  const add = (f: Omit<Finding, "id" | "relatedRecordIds">, records: SourceRecord[]) =>
    findings.push({
      ...f,
      id: `f${findings.length + 1}`,
      relatedRecordIds: records.map((r) => r.id),
    });

  const open = relevant.filter((r) => r.kind === "task" && !r.done);
  const weekAhead = addDays(today, 7);
  const overdue = open.filter((r) => r.dueOn && r.dueOn < today);
  const dueSoon = open.filter((r) => r.dueOn && r.dueOn >= today && r.dueOn <= weekAhead);
  for (const r of overdue) {
    add(
      {
        kind: "outstanding",
        summary: `${r.title} was due ${dayMonth(r.dueOn!)} and isn't finished.`,
        certainty: "verified",
        evidence: [evidence(r)],
      },
      [r],
    );
  }
  for (const r of dueSoon) {
    add(
      {
        kind: "outstanding",
        summary: `${r.title} is due ${r.dueOn === today ? "today" : dayMonth(r.dueOn!)}.`,
        certainty: "verified",
        evidence: [evidence(r)],
      },
      [r],
    );
  }
  const unowned = open.filter((r) => !r.owner);
  if (unowned.length) {
    add(
      {
        kind: "outstanding",
        summary:
          unowned.length === 1
            ? `Nobody is assigned to ${unowned[0]!.title}.`
            : `${unowned.length} open tasks have nobody assigned.`,
        certainty: "verified",
        evidence: unowned.slice(0, 10).map(evidence),
      },
      unowned,
    );
  }

  // Two open tasks with nearly the same title are probably the same job.
  const words = new Map(open.map((r) => [r, titleWords(r)]));
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const a = words.get(open[i]!)!;
      const b = words.get(open[j]!)!;
      const shared = [...a].filter((w) => b.has(w)).length;
      const union = new Set([...a, ...b]).size;
      if (shared >= 2 && shared / union >= 0.6) {
        add(
          {
            kind: "possible_duplicate",
            summary: `${open[i]!.title} and ${open[j]!.title} look like the same job.`,
            certainty: "inferred",
            evidence: [evidence(open[i]!), evidence(open[j]!)],
          },
          [open[i]!, open[j]!],
        );
      }
    }
  }

  return {
    summary: summarise(relevant.length, keywords, overdue.length, dueSoon.length),
    keywords,
    findings,
    matches: relevant.slice(0, 25).map(evidence),
  };
}

function summarise(found: number, keywords: string[], overdue: number, soon: number) {
  const about = keywords.length ? ` about “${keywords.join(" ")}”` : "";
  if (!found) return keywords.length ? `Nothing found${about}.` : "Nothing open found.";
  const items = `${found} ${keywords.length ? "" : "open "}item${found === 1 ? "" : "s"}`;
  const extra = [overdue && `${overdue} overdue`, soon && `${soon} due in the next week`].filter(
    Boolean,
  );
  return `Found ${items}${about}${extra.length ? `: ${extra.join(", ")}` : ""}.`;
}
