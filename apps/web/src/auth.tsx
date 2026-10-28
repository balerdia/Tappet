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
import { Navigate, Outlet, useNavigate, useSearchParams } from "react-router";
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

/**
 * Clerk hands the router full addresses ("http://host/organise"), but the
 * router wants a path. Other sites are opened as a normal page load.
 */
function toPath(to: string) {
  const url = new URL(to, window.location.href);
  return url.origin === window.location.origin ? url.pathname + url.search + url.hash : undefined;
}

/** Where to go after signing in: the page they came from, never back to sign-in. */
function afterSignIn(redirect: string | null) {
  const path = redirect ? toPath(redirect) : undefined;
  if (!path || /^\/(sign-in|sign-up)/.test(path)) return "/";
  return path;
}

/** Root route element. Sits inside the router so Clerk can navigate with it. */
export function AuthRoot() {
  const navigate = useNavigate();
  if (!publishableKey) return <Outlet />;
  return (
    <ClerkProvider
      publishableKey={publishableKey}
      routerPush={(to) => {
        const path = toPath(to);
        if (path) navigate(path);
        else window.location.assign(to);
      }}
      routerReplace={(to) => {
        const path = toPath(to);
        if (path) navigate(path, { replace: true });
        else window.location.replace(to);
      }}
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

/** Someone already signed in doesn't need this page; send them on. */
function LeaveIfSignedIn() {
  const [params] = useSearchParams();
  return <Navigate to={afterSignIn(params.get("redirect_url"))} replace />;
}

export function SignInPage() {
  return (
    <AuthPage>
      <Show when="signed-in">
        <LeaveIfSignedIn />
      </Show>
      <Show when="signed-out">
        <SignIn routing="path" path="/sign-in" />
      </Show>
    </AuthPage>
  );
}

export function SignUpPage() {
  return (
    <AuthPage>
      <Show when="signed-in">
        <LeaveIfSignedIn />
      </Show>
      <Show when="signed-out">
        <SignUp routing="path" path="/sign-up" />
      </Show>
    </AuthPage>
  );
}

export function AccountButton() {
  return authEnabled ? <UserButton /> : null;
}
