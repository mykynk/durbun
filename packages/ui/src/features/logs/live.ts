import { useEffect, useState } from 'react';
import type { LogEntry } from '@durbun/protocol';
import { isCrashEntry, keptAfter, logStore, useConnection } from '../../data';
import { isMarkedDuplicate, isTwinPair } from './model/dedupe';
import { isPreviousLaunch } from './model/types';
import { isDeviceCrashRecord } from '../../sources/text';

/**
 * Live vs history. After every (re)connect the server replays its buffer as `history` before live
 * `batch`es; `liveReceived` only counts the latter. Entries with an id above the store's last id at the
 * moment the connection turned 'live' are live — a crash among them deserves a banner, a replayed one
 * does not.
 */
let liveStartId = useConnection.getState().status === 'live' ? logStore.lastId : Infinity;

useConnection.subscribe((s, prev) => {
  if (s.status === prev.status) return;
  // The dispatcher flips to 'live' synchronously before appending the first live batch, so lastId here is
  // the last history entry.
  if (s.status === 'live') liveStartId = logStore.lastId;
  else if (s.status === 'syncing') liveStartId = Infinity;
});

export function isLiveEntry(e: Pick<LogEntry, 'id'>): boolean {
  return e.id > liveStartId;
}

export interface LiveCrashState {
  /** Live crash-like entries in scope (oldest first, at most 50). */
  list: LogEntry[];
  /** Entries up to this id were dismissed. */
  dismissedId: number;
}

/**
 * Watches the store for LIVE crash / ANR / Flutter-error entries in scope. Runs outside React rendering
 * (store subscription, own cursor) and also while the view is paused or hidden.
 */
/**
 * Crash rows that must not raise the banner: device crash records the server matched to a live line
 * (`data.duplicateOf`), and records of crashes from before Dürbün started watching (old news, not live).
 */
export function isQuietCrashRecord(e: LogEntry): boolean {
  if (e.data === undefined) return false;
  return isMarkedDuplicate(e) || (isDeviceCrashRecord(e) && isPreviousLaunch(e));
}

export function useLiveCrashes(scope: (e: LogEntry) => boolean, scopeKey: string, onCrash?: (e: LogEntry) => void): [LiveCrashState, (id: number) => void] {
  const [state, setState] = useState<LiveCrashState>({ list: [], dismissedId: 0 });
  const onCrashRef = useLatest(onCrash);

  useEffect(() => {
    setState({ list: [], dismissedId: 0 });
    let list: LogEntry[] = [];
    let gen = logStore.generation;
    let cursor = logStore.lastId;
    const scan = () => {
      if (logStore.generation !== gen) {
        gen = logStore.generation;
        // A resync replaced the store (ids may restart after a server restart): scan again from the
        // start — replayed history is skipped by isLiveEntry. Scoped clears keep the cursor (no repeats).
        if (logStore.lastId < cursor) cursor = 0;
        // Cleared crashes leave the banner ("Çökmeye git" must not point at a row that is gone).
        const kept = list.filter((e) => {
          const cur = logStore.getById(e.id);
          return !!cur && cur.ts === e.ts && cur.message === e.message;
        });
        if (kept.length !== list.length) {
          list = kept;
          setState((s) => ({ list: kept, dismissedId: s.dismissedId }));
        }
      }
      const entries = logStore.entries;
      const from = logStore.lowerBound(cursor + 1);
      // Crashes a burst pushed out of the ring before this scan live on in logStore.kept.
      const trimmed = keptAfter(logStore.kept, cursor);
      if (from >= entries.length && trimmed.length === 0) return;
      const found: LogEntry[] = [];
      for (const e of trimmed) if (isCrashEntry(e) && isLiveEntry(e) && scope(e) && !isQuietCrashRecord(e)) found.push(e);
      for (let i = from; i < entries.length; i++) {
        const e = entries[i]!;
        if (isCrashEntry(e) && isLiveEntry(e) && scope(e) && !isQuietCrashRecord(e)) found.push(e);
      }
      cursor = Math.max(cursor, entries.length > 0 ? entries[entries.length - 1]!.id : 0, trimmed.length > 0 ? trimmed[trimmed.length - 1]!.id : 0);
      if (found.length === 0) return;
      const fresh: LogEntry[] = [];
      const next = mergeCrashes(list, found, fresh);
      if (next === list) return;
      list = next;
      setState((s) => ({ list: next, dismissedId: s.dismissedId }));
      for (const e of fresh) onCrashRef.current?.(e);
    };
    const unsubscribe = logStore.subscribe(scan);
    return unsubscribe;
    // scope is captured per scopeKey on purpose (the compiled scope object changes with every app stat update)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  const dismiss = (id: number) => setState((s) => ({ ...s, dismissedId: Math.max(s.dismissedId, id) }));
  return [state, dismiss];
}

/**
 * Append live crashes to the banner list (at most 50). The app SDK report and the device log's copy of
 * the same crash count once: a twin replaces its partner when it is the app copy (better headline,
 * visible row), otherwise it is dropped. `fresh` receives the entries that are new crashes.
 */
export function mergeCrashes(list: readonly LogEntry[], found: readonly LogEntry[], fresh: LogEntry[]): LogEntry[] {
  let out: LogEntry[] | null = null;
  for (const e of found) {
    const cur: LogEntry[] = out ?? list.slice();
    let twin = -1;
    for (let i = cur.length - 1; i >= 0 && i >= cur.length - 8; i--) {
      if (isTwinPair(cur[i]!, e)) {
        twin = i;
        break;
      }
    }
    if (twin >= 0) {
      if (e.source === 'app' && cur[twin]!.source !== 'app') {
        cur[twin] = e;
        out = cur;
      }
      continue;
    }
    cur.push(e);
    fresh.push(e);
    out = cur;
  }
  if (!out) return list as LogEntry[];
  return out.length > 50 ? out.slice(-50) : out;
}

function useLatest<T>(value: T): { current: T } {
  const [ref] = useState(() => ({ current: value }));
  ref.current = value;
  return ref;
}
