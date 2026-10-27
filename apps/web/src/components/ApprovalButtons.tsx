import { useState } from "react";
import { api } from "../api";
import { Button, ErrorText } from "./ui";

/** Approve or decline one waiting step. */
export function ApprovalButtons({
  runId,
  path,
  onDone,
}: {
  runId: string;
  path: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function answer(decision: "approved" | "rejected") {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/runs/${runId}/approvals`, {
        method: "POST",
        body: JSON.stringify({ path, decision }),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <Button tone="primary" disabled={busy} onClick={() => answer("approved")}>
          Approve
        </Button>
        <Button disabled={busy} onClick={() => answer("rejected")}>
          Decline
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
