import type { SourceRecord } from "@tappet/connectors";

/**
 * How sure we are about something. The UI must always show this, so people
 * can tell facts from guesses.
 *   verified  – stated directly in a source and linked to it
 *   inferred  – a reasonable connection the system made
 *   uncertain – possible, needs a person to check
 */
export type Certainty = "verified" | "inferred" | "uncertain";

export type Evidence = {
  connector: string;
  recordId: string;
  title: string;
  url?: string;
  excerpt: string;
  retrievedAt: string;
};

export type FindingKind =
  | "commitment"
  | "decision"
  | "outstanding"
  | "missing_task"
  | "contradiction"
  | "possible_duplicate";

export type Finding = {
  id: string;
  kind: FindingKind;
  summary: string;
  certainty: Certainty;
  evidence: Evidence[];
  relatedRecordIds: string[];
};

export type Relationship = {
  from: string;
  to: string;
  type: "same_project" | "mentions" | "implements" | "duplicates" | "contradicts";
  certainty: Certainty;
  evidence: Evidence[];
};

/** A commitment pulled out of a source, e.g. "we'll send the press kit by Friday". */
export type Commitment = {
  id: string;
  text: string;
  owner?: string;
  due?: string;
  source: SourceRecord;
  excerpt: string;
};

export function evidenceFrom(record: SourceRecord, excerpt: string, retrievedAt: string): Evidence {
  return {
    connector: record.connector,
    recordId: record.id,
    title: record.title,
    url: record.url,
    excerpt,
    retrievedAt,
  };
}
