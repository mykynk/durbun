import { create } from 'zustand';
import type { ServerToUi } from '@durbun/protocol';
import { onServerMessage } from '../data/events';
import type { AppGroup } from '../data/stores/hub';

/** What a `cleared` message from the server removed (the user's own "Clear" in a view or for an app). */
export type ClearRecord = Pick<Extract<ServerToUi, { type: 'cleared' }>, 'target' | 'deviceId' | 'appId' | 'bundleId'> & { at: number };

const MAX_RECORDS = 50;

interface ClearedState {
  records: ClearRecord[];
}

/**
 * Clears seen in this window, so an empty list can say "you cleared it" instead of "the app sent nothing yet".
 * Kept across reconnects: a snapshot after a clear is still a cleared list.
 */
export const useCleared = create<ClearedState>(() => ({ records: [] }));

export function noteCleared(msg: Omit<ClearRecord, 'at'>, at = Date.now()): void {
  useCleared.setState((s) => ({ records: [...s.records.slice(-(MAX_RECORDS - 1)), { ...msg, at }] }));
}

/** Test helper. */
export function resetCleared(): void {
  useCleared.setState({ records: [] });
}

type Target = 'logs' | 'network' | 'metrics';

/** True when a clear of `target` (or of everything) covered this app group. */
export function wasCleared(records: readonly ClearRecord[], group: Pick<AppGroup, 'deviceId' | 'bundleId' | 'sessions'>, target: Target): boolean {
  return records.some((r) => {
    if (r.target !== target && r.target !== 'all') return false;
    if (!r.deviceId && !r.appId) return true;
    if (r.appId) return group.sessions.some((s) => s.id === r.appId) && (!r.deviceId || r.deviceId === group.deviceId);
    if (r.deviceId !== group.deviceId) return false;
    return !r.bundleId || r.bundleId === group.bundleId;
  });
}

export function useWasCleared(group: Pick<AppGroup, 'deviceId' | 'bundleId' | 'sessions'> | undefined, target: Target): boolean {
  return useCleared((s) => (group ? wasCleared(s.records, group, target) : false));
}

onServerMessage((msg) => {
  if (msg.type === 'cleared') noteCleared({ target: msg.target, deviceId: msg.deviceId, appId: msg.appId, bundleId: msg.bundleId });
});
