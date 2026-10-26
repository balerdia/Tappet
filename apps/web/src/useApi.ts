import { useEffect, useState } from "react";
import { api } from "./api";

type State<T> = { data?: T; error?: string; loading: boolean };

export function useApi<T>(path: string): State<T> {
  const [state, setState] = useState<State<T>>({ loading: true });
  useEffect(() => {
    let live = true;
    api<T>(path)
      .then((data) => live && setState({ data, loading: false }))
      .catch((e: Error) => live && setState({ error: e.message, loading: false }));
    return () => {
      live = false;
    };
  }, [path]);
  return state;
}
