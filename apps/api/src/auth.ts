import { createClerkClient, verifyToken } from "@clerk/backend";
import { and, eq, schema, type Database } from "@tappet/db";

/** Who the sign-in provider says is calling. */
export type Identity = { subject: string };
export type Profile = { email: string; name?: string };

/**
 * The sign-in provider, kept behind two calls so tests and other providers
 * can stand in for Clerk.
 */
export type Authenticator = {
  /** Checks the session token. Undefined when it's missing, expired or forged. */
  verify(token: string): Promise<Identity | undefined>;
  /** Only called the first time someone signs in, to create their account. */
  profile(subject: string): Promise<Profile>;
};

export function clerkAuthenticator(opts: {
  secretKey: string;
  /** Origins allowed to have issued the token, e.g. https://app.tappet.com. */
  authorizedParties?: string[];
}): Authenticator {
  const clerk = createClerkClient({ secretKey: opts.secretKey });
  return {
    async verify(token) {
      try {
        const claims = await verifyToken(token, {
          secretKey: opts.secretKey,
          authorizedParties: opts.authorizedParties,
        });
        return claims.sub ? { subject: claims.sub } : undefined;
      } catch {
        return undefined;
      }
    },
    async profile(subject) {
      const user = await clerk.users.getUser(subject);
      const email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress;
      if (!email) throw new Error("This account has no email address.");
      const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined;
      return { email, name };
    },
  };
}

export function bearerToken(header: string | undefined) {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

/**
 * Finds the person's user and workspace, creating both on first sign-in.
 * That first request is what "signing up" means on the API side.
 *
 * The workspace id is derived from the user id, so two first requests racing
 * each other end up with one workspace rather than two.
 */
export async function findOrCreateAccount(
  db: Database,
  auth: Authenticator,
  identity: Identity,
  newId: (prefix: string) => string,
): Promise<{ userId: string; workspaceId: string }> {
  let [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.authSubject, identity.subject));

  if (!user) {
    const profile = await auth.profile(identity.subject);
    const [byEmail] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, profile.email));
    if (byEmail && !byEmail.authSubject) {
      // Someone added before they had signed in (an invite, say). Link them.
      await db
        .update(schema.users)
        .set({ authSubject: identity.subject })
        .where(eq(schema.users.id, byEmail.id));
    } else {
      await db
        .insert(schema.users)
        .values({
          id: newId("user"),
          email: profile.email,
          name: profile.name,
          authSubject: identity.subject,
        })
        .onConflictDoNothing();
    }
    [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.authSubject, identity.subject));
    if (!user) throw new Error("Couldn't create the account.");
  }

  const [membership] = await db
    .select()
    .from(schema.memberships)
    .where(eq(schema.memberships.userId, user.id));
  if (membership) return { userId: user.id, workspaceId: membership.workspaceId };

  const workspaceId = `ws_${user.id.replace(/^user_/, "")}`;
  await db
    .insert(schema.workspaces)
    .values({ id: workspaceId, name: "My business" })
    .onConflictDoNothing();
  await db
    .insert(schema.memberships)
    .values({ workspaceId, userId: user.id, role: "owner" })
    .onConflictDoNothing();
  await db.insert(schema.auditLog).values({
    workspaceId,
    actorId: user.id,
    action: "account.created",
    subject: user.id,
  });
  const [created] = await db
    .select()
    .from(schema.memberships)
    .where(
      and(eq(schema.memberships.userId, user.id), eq(schema.memberships.workspaceId, workspaceId)),
    );
  if (!created) throw new Error("Couldn't create the workspace.");
  return { userId: user.id, workspaceId };
}
