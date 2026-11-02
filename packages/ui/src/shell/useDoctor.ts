import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import type { ToolCheck } from '@durbun/protocol';
import { doctor } from '../data/api';
import { errorText } from '../i18n/codes';

interface DoctorState {
  checks: ToolCheck[] | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
}

const useDoctorStore = create<DoctorState>()(() => ({ checks: null, loading: false, error: null, fetchedAt: null }));
let inflight: Promise<void> | null = null;

export function refreshDoctor(): Promise<void> {
  if (inflight) return inflight;
  useDoctorStore.setState({ loading: true, error: null });
  inflight = doctor()
    .then((checks) => useDoctorStore.setState({ checks: Array.isArray(checks) ? checks : [], loading: false, fetchedAt: Date.now() }))
    .catch((err: unknown) => useDoctorStore.setState({ loading: false, error: errorText(err) }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Doctor checks (GET /api/doctor), fetched on first use and cached; `refresh()` re-runs them. */
export function useDoctor(opts: { auto?: boolean; maxAgeMs?: number } = {}) {
  const state = useDoctorStore();
  const { auto = true, maxAgeMs = 60_000 } = opts;
  useEffect(() => {
    if (!auto) return;
    const s = useDoctorStore.getState();
    if (s.loading) return;
    if (!s.fetchedAt || Date.now() - s.fetchedAt > maxAgeMs) void refreshDoctor();
  }, [auto, maxAgeMs]);
  const refresh = useCallback(() => refreshDoctor(), []);
  return { ...state, refresh };
}

/** Find a check whose id contains any of the given fragments (ids are server-defined). */
export function findCheck(checks: ToolCheck[] | null, ...fragments: string[]): ToolCheck | undefined {
  if (!checks) return undefined;
  return checks.find((c) => fragments.some((f) => c.id.toLowerCase().includes(f)));
}
