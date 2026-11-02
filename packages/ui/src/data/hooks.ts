import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { logStore, type LogCounts } from './logStore';
import { networkStore, type NetworkCounts } from './networkStore';
import { metricsStore } from './metricsStore';
import type { VersionedSource } from './versioned';
import { scopeLogCounts, scopeNetworkCounts, useCompiledScope } from './scope';

export interface VersionHookOptions {
  /** Re-render at most every `throttleMs` (badges, counters). Default 0 = every frame with changes. */
  throttleMs?: number;
  /** Stop re-rendering while false (e.g. hidden tab: `enabled: useFeatureActive()`). Default true. */
  enabled?: boolean;
}

/**
 * Subscribe a component to a versioned store. Returns the store version; use it as a dependency for
 * memos that read the mutable store data.
 */
export function useStoreVersion(store: VersionedSource, opts: VersionHookOptions = {}): number {
  const { throttleMs = 0, enabled = true } = opts;
  const snap = useRef(store.version);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!enabled) return () => {};
      snap.current = store.version;
      if (throttleMs <= 0) {
        return store.subscribe(() => {
          snap.current = store.version;
          onChange();
        });
      }
      let last = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const fire = () => {
        timer = null;
        last = Date.now();
        snap.current = store.version;
        onChange();
      };
      const unsubscribe = store.subscribe(() => {
        if (timer) return;
        const wait = throttleMs - (Date.now() - last);
        if (wait <= 0) fire();
        else timer = setTimeout(fire, wait);
      });
      return () => {
        unsubscribe();
        if (timer) clearTimeout(timer);
      };
    },
    [store, throttleMs, enabled],
  );
  const get = () => snap.current;
  return useSyncExternalStore(subscribe, get, get);
}

/** Re-render when logs change (at most once per frame). Read `logStore.entries` afterwards. */
export function useLogVersion(opts?: VersionHookOptions): number {
  return useStoreVersion(logStore, opts);
}

/** Re-render when network entries change. Read `networkStore.byId` / `networkStore.list()`. */
export function useNetworkVersion(opts?: VersionHookOptions): number {
  return useStoreVersion(networkStore, opts);
}

/** Re-render when metric samples arrive. Read `metricsStore.series`. */
export function useMetricsVersion(opts?: VersionHookOptions): number {
  return useStoreVersion(metricsStore, opts);
}

/** Log counters for the current scope (throttled, default 250 ms). */
export function useScopedLogCounts(throttleMs = 250): LogCounts {
  const compiled = useCompiledScope();
  const v = useLogVersion({ throttleMs });
  return useMemo(() => scopeLogCounts(compiled, logStore), [compiled, v]);
}

/** Network counters for the current scope (throttled, default 250 ms). */
export function useScopedNetworkCounts(throttleMs = 250): NetworkCounts {
  const compiled = useCompiledScope();
  const v = useNetworkVersion({ throttleMs });
  return useMemo(() => scopeNetworkCounts(compiled, networkStore), [compiled, v]);
}

/* ───────────── Rates ───────────── */

export interface IngestRate {
  /** Log lines per second (smoothed over ~3 s). */
  logsPerSec: number;
  /** New network requests per second. */
  requestsPerSec: number;
  /** Last 60 per-second log counts (oldest first) for a sparkline. */
  history: number[];
}

const rateState: IngestRate = { logsPerSec: 0, requestsPerSec: 0, history: [] };
const rateListeners = new Set<() => void>();
let rateTimer: ReturnType<typeof setInterval> | null = null;
let lastLogTotal = 0;
let lastNetTotal = 0;
const window3: number[] = [];
let current: IngestRate = rateState;

function tickRates(): void {
  const logs = logStore.liveReceived;
  const nets = networkStore.liveReceived;
  const dLogs = Math.max(0, logs - lastLogTotal);
  const dNets = Math.max(0, nets - lastNetTotal);
  lastLogTotal = logs;
  lastNetTotal = nets;
  window3.push(dLogs);
  if (window3.length > 3) window3.shift();
  const history = [...current.history, dLogs].slice(-60);
  current = {
    logsPerSec: window3.reduce((a, b) => a + b, 0) / window3.length,
    requestsPerSec: dNets,
    history,
  };
  rateListeners.forEach((l) => l());
}

function subscribeRates(listener: () => void): () => void {
  rateListeners.add(listener);
  if (!rateTimer) {
    lastLogTotal = logStore.liveReceived;
    lastNetTotal = networkStore.liveReceived;
    rateTimer = setInterval(tickRates, 1000);
  }
  return () => {
    rateListeners.delete(listener);
    if (rateListeners.size === 0 && rateTimer) {
      clearInterval(rateTimer);
      rateTimer = null;
    }
  };
}

/** Ingest rate, updated once per second. */
export function useIngestRate(): IngestRate {
  return useSyncExternalStore(
    subscribeRates,
    () => current,
    () => current,
  );
}

/** Current time, refreshed every `intervalMs` (for relative times). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
