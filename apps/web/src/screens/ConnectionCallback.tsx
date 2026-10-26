import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../api";
import { Card } from "../components/ui";

/**
 * Where an app sends people back after they approve the connection. We hand
 * the one-time code to the API, then return to the Connections screen.
 */
export function ConnectionCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const sent = useRef(false);

  useEffect(() => {
    // The code works once; don't send it twice (React runs effects twice in dev).
    if (sent.current) return;
    sent.current = true;

    const code = params.get("code");
    const state = params.get("state");
    if (params.get("error")) {
      setError(
        params.get("error") === "access_denied"
          ? "You didn't give permission, so nothing was connected."
          : "The app couldn't connect. Please try again.",
      );
      return;
    }
    if (!code || !state) {
      setError("This page needs a link from the app you were connecting.");
      return;
    }
    api("/connections/complete", { method: "POST", body: JSON.stringify({ code, state }) })
      .then(() => navigate("/connections", { replace: true }))
      .catch((e: Error) => setError(e.message));
  }, [params, navigate]);

  return (
    <Card className="mx-auto max-w-md text-center">
      {error ? (
        <>
          <p className="text-uncertain">{error}</p>
          <Link to="/connections" className="mt-4 inline-block text-sm text-accent hover:underline">
            Back to Connections
          </Link>
        </>
      ) : (
        <p className="text-muted">Finishing the connection…</p>
      )}
    </Card>
  );
}
