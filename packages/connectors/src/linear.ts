import { linear } from "./manifests.js";
import type { ConnectorRuntime, OAuthClient, OAuthTokens } from "./types.js";

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const REVOKE_URL = "https://api.linear.app/oauth/revoke";
const GRAPHQL_URL = "https://api.linear.app/graphql";

export type LinearOAuthConfig = { clientId: string; clientSecret: string };

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string | string[];
  error?: string;
  error_description?: string;
};

export function createLinearOAuth(
  config: LinearOAuthConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): OAuthClient {
  async function token(params: Record<string, string>): Promise<OAuthTokens> {
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...params,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || !body.access_token) {
      throw new LinearAuthError(
        body.error_description ?? body.error ?? `Linear replied ${res.status}.`,
      );
    }
    const scopes = Array.isArray(body.scope) ? body.scope : (body.scope ?? "").split(/[ ,]+/);
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: body.expires_in
        ? new Date(now().getTime() + body.expires_in * 1000).toISOString()
        : undefined,
      scopes: scopes.filter(Boolean),
    };
  }

  return {
    authorizeUrl(state, redirectUri) {
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: linearScopes().join(","),
        state,
        prompt: "consent",
      }).toString();
      return url.toString();
    },
    exchangeCode: (code, redirectUri) =>
      token({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    refresh: (refreshToken) => token({ grant_type: "refresh_token", refresh_token: refreshToken }),
    async describe(accessToken) {
      const data = await graphql<{ organization: { name: string } }>(
        fetchImpl,
        accessToken,
        "query { organization { name } }",
      );
      return data.organization.name;
    },
    async revoke(accessToken) {
      await fetchImpl(REVOKE_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` },
      });
    },
  };
}

function linearScopes() {
  return linear.auth.kind === "oauth2" ? linear.auth.scopes : [];
}

/** Linear refused the credentials. The connection needs to be made again. */
export class LinearAuthError extends Error {}

async function graphql<T>(
  fetchImpl: typeof fetch,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetchImpl(GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) throw new LinearAuthError("Linear needs to be connected again.");
  const body = (await res.json().catch(() => ({}))) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (body.errors?.length) throw new Error(`Linear said: ${body.errors[0]!.message}`);
  if (!res.ok || !body.data) throw new Error(`Linear replied ${res.status}.`);
  return body.data;
}

type IssueNode = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  dueDate?: string | null;
  state?: { name: string; type: string } | null;
  assignee?: { email: string } | null;
};

const ISSUE_FIELDS = "id identifier title url dueDate state { name type } assignee { email }";

/** Flattens an issue into the shape workflows reference (`task.state`, `task.assigneeEmail`). */
function toTask(n: IssueNode) {
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    url: n.url,
    dueDate: n.dueDate ?? null,
    state: n.state?.type ?? null,
    stateName: n.state?.name ?? null,
    assigneeEmail: n.assignee?.email ?? null,
  };
}

const optionalString = (v: unknown) =>
  v === undefined || v === null || v === "" ? undefined : String(v);

export function createLinearConnector(
  fetchImpl: typeof fetch = fetch,
  today: () => Date = () => new Date(),
): ConnectorRuntime {
  return {
    manifest: linear,
    actions: {
      async createIssue(input, ctx) {
        const token = ctx.credentials.accessToken!;
        let teamId = optionalString(input.teamId);
        if (!teamId) {
          // No team chosen: use the first one the person can see.
          const { teams } = await graphql<{ teams: { nodes: { id: string }[] } }>(
            fetchImpl,
            token,
            "query { teams(first: 1) { nodes { id } } }",
          );
          teamId = teams.nodes[0]?.id;
          if (!teamId) throw new Error("This Linear workspace has no teams to add tasks to.");
        }
        const { issueCreate } = await graphql<{
          issueCreate: { success: boolean; issue: IssueNode | null };
        }>(
          fetchImpl,
          token,
          `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
          {
            input: {
              teamId,
              title: String(input.title),
              description: optionalString(input.description),
              dueDate: optionalString(input.dueDate),
            },
          },
        );
        if (!issueCreate.success || !issueCreate.issue)
          throw new Error("Linear didn't create the task.");
        return toTask(issueCreate.issue);
      },

      async searchIssues(input, ctx) {
        const token = ctx.credentials.accessToken!;
        const query = optionalString(input.query);
        if (query) {
          const { searchIssues } = await graphql<{ searchIssues: { nodes: IssueNode[] } }>(
            fetchImpl,
            token,
            `query($term: String!) { searchIssues(term: $term, first: 100) { nodes { ${ISSUE_FIELDS} } } }`,
            { term: query },
          );
          return { items: searchIssues.nodes.map(toTask) };
        }
        const filter: Record<string, unknown> = {
          state: { type: { nin: ["completed", "canceled"] } },
        };
        if (input.filter === "overdue") {
          filter.dueDate = { lt: today().toISOString().slice(0, 10) };
        }
        const { issues } = await graphql<{ issues: { nodes: IssueNode[] } }>(
          fetchImpl,
          token,
          `query($filter: IssueFilter) { issues(filter: $filter, first: 100) { nodes { ${ISSUE_FIELDS} } } }`,
          { filter },
        );
        return { items: issues.nodes.map(toTask) };
      },

      async updateIssue(input, ctx) {
        const token = ctx.credentials.accessToken!;
        const update = Object.fromEntries(
          ["title", "description", "stateId", "assigneeId", "dueDate"]
            .map((k) => [k, optionalString(input[k])])
            .filter(([, v]) => v !== undefined),
        );
        const { issueUpdate } = await graphql<{
          issueUpdate: { success: boolean; issue: IssueNode | null };
        }>(
          fetchImpl,
          token,
          `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
          { id: String(input.id), input: update },
        );
        if (!issueUpdate.success || !issueUpdate.issue)
          throw new Error("Linear didn't update the task.");
        return toTask(issueUpdate.issue);
      },
    },
  };
}
