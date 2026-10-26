import { createClerkClient, verifyToken } from "@clerk/backend";
import { eq, schema, type Database } from "@tappet/db";

/**
 * Sign-in sits behind this interface so the rest of the API doesn't know
 * which provider is in use. Clerk is the managed default; a self-hosted
 * deployment could plug in something else without touching the routes.
 */
export type Authenticator = {
  /** Returns a stable subject for the signed-in person, or null. */
  verify(request: Request): Promise<string | null>;
  /** Display details, fetched once when someone first signs in. */
  profile(subject: string): Promise<{ email?: string; name?: string }>;
};

export type ClerkConfig = {
  secretKey: string;
  /** Origins allowed to have issued the token, e.g. "http://localhost:5173". */
  authorizedParties?: string[];
};

export function clerkAuthenticator(config: ClerkConfig): Authenticator {
  const client = createClerkClient({ secretKey: config.secretKey });
  return {
    async verify(request) {
      const header = request.headers.get("authorization");
      const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
      if (!token) return null;
      const result = await verifyToken(token, {
        secretKey: config.secretKey,
        authorizedParties: config.authorizedParties,
      });
      const sub = (result.data as { sub?: unknown } | undefined)?.sub;
      return typeof sub === "string" && sub ? `clerk:${sub}` : null;
    },
    async profile(subject) {
      const user = await client.users.getUser(subject.replace(/^clerk:/, ""));
      return {
        email: user.primaryEmailAddress?.emailAddress,
        name: user.fullName ?? undefined,
      };
    },
  };
}

/** Local development only: everyone is the same developer. */
export const devAuthenticator: Authenticator = {
  verify: async () => "dev",
  profile: async () => ({ email: "dev@localhost", name: "Developer" }),
};

/** Reads Clerk settings from environment variables, if present. */
export function clerkConfigFromEnv(
  env: Record<string, string | undefined>,
): ClerkConfig | undefined {
  if (!env.CLERK_SECRET_KEY) return undefined;
  const parties = env.CLERK_AUTHORIZED_PARTIES?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    secretKey: env.CLERK_SECRET_KEY,
    authorizedParties: parties?.length ? parties : undefined,
  };
}

/**
 * Finds the person's user record and workspace, creating both on first
 * sign-in. Ids derive from the subject, so two first requests racing each
 * other end up with the same records rather than duplicates.
 */
export async function resolveMember(
  db: Database,
  auth: Authenticator,
  subject: string,
  newId: (prefix: string) => string,
): Promise<{ userId: string; workspaceId: string }> {
  let [user] = await db.select().from(schema.users).where(eq(schema.users.externalId, subject));

  if (!user) {
    const profile = await auth
      .profile(subject)
      .catch(() => ({}) as { email?: string; name?: string });
    await db
      .insert(schema.users)
      .values({ id: newId("user"), externalId: subject, email: profile.email, name: profile.name })
      .onConflictDoNothing();
    [user] = await db.select().from(schema.users).where(eq(schema.users.externalId, subject));
    if (!user) throw new Error("Couldn't create the user record.");
  }

  const [membership] = await db
    .select()
    .from(schema.memberships)
    .where(eq(schema.memberships.userId, user.id))
    .limit(1);
  if (membership) return { userId: user.id, workspaceId: membership.workspaceId };

  // First sign-in: give them their own workspace.
  const workspaceId = `ws_${user.id.replace(/^user_/, "")}`;
  await db
    .insert(schema.workspaces)
    .values({ id: workspaceId, name: "My business" })
    .onConflictDoNothing();
  await db
    .insert(schema.memberships)
    .values({ workspaceId, userId: user.id, role: "owner" })
    .onConflictDoNothing();
  return { userId: user.id, workspaceId };
}
