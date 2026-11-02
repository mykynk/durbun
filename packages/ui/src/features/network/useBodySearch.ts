import { useEffect, useRef, useState } from 'react';
import { api, useNetworkVersion } from '../../data';

export interface BodySearchState {
  /** Matching request ids for `text` (null while not searched yet / inactive). */
  matches: ReadonlySet<string> | null;
  loading: boolean;
  error: unknown;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Server-side search over URLs, headers and bodies (`POST /api/network/search`): debounced (300 ms),
 * aborted when the text changes, refreshed at most every 2 s while new traffic arrives. The returned
 * set keeps its identity while the result does not change (no needless re-filtering).
 */
export function useBodySearch(text: string, active: boolean): BodySearchState {
  const [state, setState] = useState<BodySearchState & { text: string }>({ text: '', matches: null, loading: false, error: null });
  const v = useNetworkVersion({ throttleMs: 2000, enabled: active && text !== '' });
  const last = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    if (!text) {
      last.current = null;
      setState({ text: '', matches: null, loading: false, error: null });
      return;
    }
    if (!active) return;
    const ctrl = new AbortController();
    setState((s) => (s.text === text ? { ...s, loading: true } : { text, matches: null, loading: true, error: null }));
    const timer = setTimeout(() => {
      api.searchNetwork(text, { signal: ctrl.signal }).then(
        (ids) => {
          if (ctrl.signal.aborted) return;
          const next = new Set(ids);
          const keep = last.current && sameSet(last.current, next) ? last.current : next;
          last.current = keep;
          setState({ text, matches: keep, loading: false, error: null });
        },
        (error: unknown) => {
          if (ctrl.signal.aborted || (error as { name?: string })?.name === 'AbortError') return;
          setState((s) => ({ ...s, text, loading: false, error }));
        },
      );
    }, 300);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [text, v, active]);

  if (state.text !== text) return { matches: null, loading: text !== '', error: null };
  return { matches: state.matches, loading: state.loading, error: state.error };
}
