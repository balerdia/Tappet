import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

type State<T> = { data?: T; error?: string; loading: boolean };

/**
 * Loads from the API. With `refreshMs`, keeps it fresh while the page is
 * visible, without flashing a loading state on each refresh.
 */
export function useApi<T>(
  path: string,
  options: { refreshMs?: number } = {},
): State<T> & { reload: () => void } {
  const [state, setState] = useState<State<T>>({ loading: true });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let live = true;
    api<T>(path)
      .then((data) => live && setState({ data, loading: false }))
      .catch((e: Error) => live && setState((s) => ({ ...s, error: e.message, loading: false })));
    return () => {
      live = false;
    };
  }, [path, version]);

  useEffect(() => {
    if (!options.refreshMs) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, options.refreshMs);
    return () => clearInterval(timer);
  }, [options.refreshMs, reload]);

  return { ...state, reload };
}
