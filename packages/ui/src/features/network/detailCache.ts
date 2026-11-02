import { useEffect, useState } from 'react';
import type { NetworkDetail, NetworkEntry } from '@durbun/protocol';
import { api } from '../../data';

/**
 * Request details (with bodies) fetched on demand from `GET /api/network/:id` and cached per id.
 * A cached detail is reused while the entry is unchanged (state, end, body flags); a pending request
 * is fetched again once its response arrives.
 */

const MAX_CACHED = 40;
const cache = new Map<string, { key: string; detail: NetworkDetail }>();

export function detailKey(e: Pick<NetworkEntry, 'state' | 'endTs' | 'hasResponseBody' | 'hasRequestBody' | 'bodyEvicted' | 'status'>): string {
  return `${e.state}|${e.endTs ?? ''}|${e.status ?? ''}|${e.hasRequestBody ? 1 : 0}${e.hasResponseBody ? 1 : 0}|${e.bodyEvicted ? 1 : 0}`;
}

export function cachedDetail(e: NetworkEntry): NetworkDetail | undefined {
  const hit = cache.get(e.id);
  return hit && hit.key === detailKey(e) ? hit.detail : undefined;
}

function remember(e: NetworkEntry, detail: NetworkDetail): void {
  cache.delete(e.id);
  cache.set(e.id, { key: detailKey(e), detail });
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
}

/** Detail of an entry (cached). Rejects with ApiError / AbortError. */
export async function loadDetail(e: NetworkEntry, signal?: AbortSignal): Promise<NetworkDetail> {
  const hit = cachedDetail(e);
  if (hit) return hit;
  const detail = await api.getNetworkDetail(e.id, signal);
  remember(e, detail);
  return detail;
}

export function clearDetailCache(): void {
  cache.clear();
}

export interface DetailState {
  detail: NetworkDetail | null;
  loading: boolean;
  error: unknown;
}

/** Fetch the detail of the selected entry; aborts when the selection changes. */
export function useNetworkDetail(entry: NetworkEntry | null): DetailState & { reload: () => void } {
  const [state, setState] = useState<DetailState & { id: string | null; key: string | null }>({ detail: null, loading: false, error: null, id: null, key: null });
  const [nonce, setNonce] = useState(0);
  const id = entry?.id ?? null;
  const key = entry ? detailKey(entry) : null;

  useEffect(() => {
    if (!entry || !id) {
      setState({ detail: null, loading: false, error: null, id: null, key: null });
      return;
    }
    const hit = nonce === 0 ? cachedDetail(entry) : undefined;
    if (hit) {
      setState({ detail: hit, loading: false, error: null, id, key });
      return;
    }
    if (nonce > 0) cache.delete(id);
    const ctrl = new AbortController();
    // Keep showing the previous detail of the same request while its update loads (no flicker).
    setState((s) => ({ detail: s.id === id ? s.detail : null, loading: true, error: null, id, key }));
    loadDetail(entry, ctrl.signal).then(
      (detail) => {
        if (!ctrl.signal.aborted) setState({ detail, loading: false, error: null, id, key });
      },
      (error: unknown) => {
        if (ctrl.signal.aborted || (error as { name?: string })?.name === 'AbortError') return;
        setState((s) => ({ detail: s.id === id ? s.detail : null, loading: false, error, id, key }));
      },
    );
    return () => ctrl.abort();
    // `entry` object identity changes on every update; the key captures what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, key, nonce]);

  const current = state.id === id ? state : { detail: null, loading: !!entry, error: null };
  return { detail: current.detail, loading: current.loading, error: current.error, reload: () => setNonce((n) => n + 1) };
}
