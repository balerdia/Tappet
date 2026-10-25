import { describe, expect, it } from "vitest";
import type { SourceRecord } from "@tappet/connectors";
import { findUncoveredCommitments, type Commitment } from "./index.js";

const email: SourceRecord = {
  connector: "gmail",
  id: "msg_1",
  kind: "email",
  title: "Re: Atlas launch plan",
  text: "Agreed: we'll send the press kit to partners by Friday, and Priya will update the pricing page.",
  updatedAt: "2026-10-20T10:00:00Z",
};

const task = (id: string, title: string): SourceRecord => ({
  connector: "linear",
  id,
  kind: "task",
  title,
  text: "",
  updatedAt: "2026-10-21T10:00:00Z",
});

const commitments: Commitment[] = [
  {
    id: "c1",
    text: "Send the press kit to partners",
    source: email,
    excerpt: "we'll send the press kit to partners by Friday",
  },
  {
    id: "c2",
    text: "Update the pricing page",
    owner: "Priya",
    source: email,
    excerpt: "Priya will update the pricing page",
  },
];

describe("findUncoveredCommitments", () => {
  it("finds the commitment with no matching task and cites the email", () => {
    const findings = findUncoveredCommitments(commitments, [
      task("LIN-1", "Update pricing page copy"),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "missing_task",
      certainty: "inferred",
      summary: 'No task covers "Send the press kit to partners".',
      evidence: [
        {
          connector: "gmail",
          recordId: "msg_1",
          excerpt: "we'll send the press kit to partners by Friday",
        },
      ],
    });
  });

  it("asks a person to check weak matches instead of guessing", () => {
    const findings = findUncoveredCommitments(
      [commitments[0]!],
      [task("LIN-2", "Design press assets")],
    );
    expect(findings[0]?.certainty).toBe("uncertain");
  });
});
