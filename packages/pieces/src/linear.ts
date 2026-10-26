import { linear as manifest } from "@tappet/connectors";
import { pieceRuntime } from "./piece.js";

/**
 * Linear, through the Activepieces Linear piece (MIT). We connect with our
 * own OAuth app; Linear accepts the OAuth token as a bearer token wherever
 * the piece expects an API key.
 */
export function linearRuntime() {
  return pieceRuntime({
    manifest,
    loadPiece: async () => (await import("@activepieces/piece-linear")).linear,
    auth: (accessToken) => ({ type: "SECRET_TEXT", secret_text: `Bearer ${accessToken}` }),
    bindings: {
      searchIssues: {
        pieceAction: "linear_issues_search",
        inputs: { query: "term", teamId: "team_id", limit: "limit" },
      },
      createIssue: {
        pieceAction: "linear_issue_create",
        inputs: {
          teamId: "team_id",
          title: "title",
          description: "description",
          assigneeId: "assignee_id",
          dueDate: "due_date",
          priority: "priority",
          projectId: "project_id",
        },
      },
      updateIssue: {
        pieceAction: "linear_issue_update",
        inputs: {
          id: "issue_id",
          title: "title",
          description: "description",
          assigneeId: "assignee_id",
          stateId: "state_id",
          dueDate: "due_date",
          priority: "priority",
        },
      },
    },
  });
}
