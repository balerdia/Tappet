import type { ReactNode } from "react";
import {
  ClerkProvider,
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
  getToken,
} from "@clerk/react";
import { Card } from "./components/ui";

/**
 * Clerk is on when its publishable key is set. Without it the app runs
 * against the API's dev sign-in, which is for local work only.
 */
const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
export const clerkEnabled = Boolean(publishableKey);

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!clerkEnabled) return <>{children}</>;
  return (
    <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/">
      {children}
    </ClerkProvider>
  );
}

/** Session token for API calls, or null when signed out or in dev mode. */
export async function sessionToken(): Promise<string | null> {
  return clerkEnabled ? getToken() : null;
}

const buttonClass = "rounded-lg px-3 py-1.5 text-sm";

export function AuthControls() {
  if (!clerkEnabled) {
    return <span className="text-xs text-muted">Dev sign-in</span>;
  }
  return (
    <>
      <Show when="signed-out">
        <SignInButton>
          <button className={`${buttonClass} text-muted hover:text-ink`}>Sign in</button>
        </SignInButton>
        <SignUpButton>
          <button className={`${buttonClass} bg-accent font-medium text-surface hover:opacity-90`}>
            Sign up
          </button>
        </SignUpButton>
      </Show>
      <Show when="signed-in">
        <UserButton />
      </Show>
    </>
  );
}

/** Shows the page only to signed-in people; everyone else sees a welcome. */
export function SignedInOnly({ children }: { children: ReactNode }) {
  if (!clerkEnabled) return <>{children}</>;
  return (
    <>
      <Show when="signed-in">{children}</Show>
      <Show when="signed-out">
        <Card className="mx-auto max-w-md text-center">
          <h1 className="text-xl font-semibold">Less setting up. More getting done.</h1>
          <p className="mt-2 mb-5 text-muted">
            Sign in to organise your information and automate your work.
          </p>
          <div className="flex justify-center gap-2">
            <SignInButton>
              <button className={`${buttonClass} border border-line`}>Sign in</button>
            </SignInButton>
            <SignUpButton>
              <button className={`${buttonClass} bg-accent font-medium text-surface`}>
                Create an account
              </button>
            </SignUpButton>
          </div>
        </Card>
      </Show>
    </>
  );
}
