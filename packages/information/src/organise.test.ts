import { describe, expect, it } from "vitest";
import type { SourceRecord } from "@tappet/connectors";
import { keywordsOf, organise } from "./organise.js";

const task = (id: string, title: string, extra: Partial<SourceRecord> = {}): SourceRecord => ({
  connector: "linear",
  id,
  kind: "task",
  title,
  url: `https://linear.app/acme/issue/${id}`,
  text: "Status: Todo.",
  updatedAt: "2026-10-20T10:00:00.000Z",
  owner: "sam@example.com",
  done: false,
  ...extra,
});

const at = { today: "2026-10-28", retrievedAt: "2026-10-28T09:00:00.000Z" };

describe("organise", () => {
  it("keeps the words a question is about, not how it's asked", () => {
    expect(keywordsOf("What's still outstanding for the launch?")).toEqual(["launch"]);
    expect(keywordsOf("What is overdue?")).toEqual([]);
  });

  it("finds what's late, due soon and unassigned, with links to each task", () => {
    const result = organise({
      ...at,
      question: "What's left for the launch?",
      records: [
        task("ENG-1", "ENG-1 Launch press kit", { dueOn: "2026-10-25" }),
        task("ENG-2", "ENG-2 Launch email", { dueOn: "2026-10-30", owner: undefined }),
        task("ENG-3", "ENG-3 Launch party", { dueOn: "2026-10-20", done: true }),
        task("ENG-4", "ENG-4 Fix login", { dueOn: "2026-10-01" }),
      ],
    });
    expect(result.summary).toBe("Found 3 items about “launch”: 1 overdue, 1 due in the next week.");
    expect(result.findings.map((f) => [f.summary, f.certainty])).toEqual([
      ["ENG-1 Launch press kit was due 25 Oct and isn't finished.", "verified"],
      ["ENG-2 Launch email is due 30 Oct.", "verified"],
      ["Nobody is assigned to ENG-2 Launch email.", "verified"],
    ]);
    expect(result.findings[0]!.evidence[0]).toMatchObject({
      connector: "linear",
      url: "https://linear.app/acme/issue/ENG-1",
    });
    // Unrelated work isn't mentioned.
    expect(JSON.stringify(result)).not.toContain("Fix login");
  });

  it("marks near-identical open tasks as a possible duplicate, not a fact", () => {
    const result = organise({
      ...at,
      question: "anything open?",
      records: [
        task("A", "ENG-7 Send invoice to Acme"),
        task("B", "ENG-9 Send Acme invoice"),
        task("C", "ENG-8 Book venue"),
        task("A", "ENG-7 Send invoice to Acme"), // Found twice, counted once.
      ],
    });
    expect(result.summary).toBe("Found 3 open items.");
    expect(result.findings).toEqual([
      expect.objectContaining({
        kind: "possible_duplicate",
        certainty: "inferred",
        relatedRecordIds: ["A", "B"],
      }),
    ]);
  });

  it("says when nothing is overdue, if that's what was asked", () => {
    const result = organise({
      ...at,
      question: "What's overdue?",
      records: [task("A", "Book venue", { dueOn: "2026-11-30" })],
    });
    expect(result.summary).toBe("Nothing is overdue. Found 1 open item.");
  });

  it("says plainly when nothing matches", () => {
    expect(
      organise({ ...at, question: "budget", records: [task("A", "Book venue")] }),
    ).toMatchObject({ summary: "Nothing found about “budget”.", findings: [], matches: [] });
  });
});
