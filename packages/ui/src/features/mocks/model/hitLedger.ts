import { useSyncExternalStore } from 'react';
import type { NetworkEntry } from '@durbun/protocol';
import { networkStore, onServerMessage } from '../../../data';

/**
 * How many requests each mock rule answered in this window's session, kept apart from the request list: clearing
 * the list or the memory limit dropping old requests must not make a rule look unused. Requests are counted once
 * (by id), from the list in memory when this starts and from every batch after it.
 */
const seen = new Map<string, Set<string>>();
let version = 0;
let started = false;
const listeners = new Set<() => void>();

/** Ids kept per rule (only to count each request once; past this the count still grows). */
const MAX_IDS_PER_RULE = 50_000;
const totals = new Map<string, number>();

function add(entries: Iterable<NetworkEntry>): boolean {
  let changed = false;
  for (const e of entries) {
    if (!e.mocked || !e.mockRuleId) continue;
    let ids = seen.get(e.mockRuleId);
    if (!ids) seen.set(e.mockRuleId, (ids = new Set()));
    if (ids.has(e.id)) continue;
    if (ids.size >= MAX_IDS_PER_RULE) ids.clear();
    ids.add(e.id);
    totals.set(e.mockRuleId, (totals.get(e.mockRuleId) ?? 0) + 1);
    changed = true;
  }
  return changed;
}

function emit(): void {
  version++;
  for (const l of listeners) l();
}

/** Starts counting (idempotent): what is in memory now, then every new request. */
export function startHitLedger(): void {
  if (started) return;
  started = true;
  add(networkStore.list());
  onServerMessage((m) => {
    if ((m.type === 'batch' || m.type === 'snapshot') && m.network?.length && add(m.network)) emit();
  });
}

/** Requests rule `id` answered this session (survives clears). */
export function sessionHits(id: string): number {
  return totals.get(id) ?? 0;
}

/** Test hook. */
export function resetHitLedger(): void {
  seen.clear();
  totals.clear();
  started = false;
  emit();
}

/** Re-renders when a count changes. */
export function useHitLedgerVersion(): number {
  startHitLedger();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
    () => version,
  );
}

/** Feed entries directly (tests; the live path is the server batches). */
export function recordHits(entries: Iterable<NetworkEntry>): void {
  if (add(entries)) emit();
}
