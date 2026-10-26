import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

type State<T> = { data?: T; error?: string; loading: boolean };

export function useApi<T>(path: string): State<T> & { reload: () => void } {
  const [state, setState] = useState<State<T>>({ loading: true });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    api<T>(path)
      .then((data) => live && setState({ data, loading: false }))
      .catch((e: Error) => live && setState({ error: e.message, loading: false }));
    return () => {
      live = false;
    };
  }, [path, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { ...state, reload };
}
