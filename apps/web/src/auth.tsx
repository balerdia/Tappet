import {
  ClerkProvider,
  RedirectToSignIn,
  Show,
  SignIn,
  SignUp,
  useAuth,
  UserButton,
} from "@clerk/react";
import type { ReactNode } from "react";
import { Outlet, useNavigate } from "react-router";
import { setTokenGetter } from "./api";

// Clerk is on when the build has a publishable key. Without one the app
// talks to an API running with dev sign-in.
const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
export const authEnabled = Boolean(publishableKey);

// Set during render, not in an effect, so it's in place before any screen's
// first request.
function TokenBridge() {
  const { getToken } = useAuth();
  setTokenGetter(() => getToken());
  return null;
}

/** Root route element. Sits inside the router so Clerk can navigate with it. */
export function AuthRoot() {
  const navigate = useNavigate();
  if (!publishableKey) return <Outlet />;
  return (
    <ClerkProvider
      publishableKey={publishableKey}
      routerPush={(to) => navigate(to)}
      routerReplace={(to) => navigate(to, { replace: true })}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
      afterSignOutUrl="/sign-in"
    >
      <TokenBridge />
      <Outlet />
    </ClerkProvider>
  );
}

/** Shows the app to signed-in people and sends everyone else to sign in. */
export function RequireSignIn({ children }: { children: ReactNode }) {
  if (!authEnabled) return <>{children}</>;
  return (
    <>
      <Show when="signed-in">{children}</Show>
      <Show when="signed-out">
        <RedirectToSignIn />
      </Show>
    </>
  );
}

function AuthPage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-12">
      <span className="text-xl font-semibold tracking-tight">Tappet</span>
      {children}
    </div>
  );
}

export function SignInPage() {
  return (
    <AuthPage>
      <SignIn routing="path" path="/sign-in" />
    </AuthPage>
  );
}

export function SignUpPage() {
  return (
    <AuthPage>
      <SignUp routing="path" path="/sign-up" />
    </AuthPage>
  );
}

export function AccountButton() {
  return authEnabled ? <UserButton /> : null;
}
