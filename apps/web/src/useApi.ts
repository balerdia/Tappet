import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

type State<T> = { data?: T; error?: string; loading: boolean; reload: () => void };

export function useApi<T>(path: string): State<T> {
  const [state, setState] = useState<Omit<State<T>, "reload">>({ loading: true });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let live = true;
    api<T>(path)
      .then((data) => live && setState({ data, loading: false }))
      .catch((e: Error) => live && setState({ error: e.message, loading: false }));
    return () => {
      live = false;
    };
  }, [path, version]);
  return { ...state, reload };
}
