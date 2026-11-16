import { useSyncExternalStore } from 'react';
import { ui } from '../../data';

/**
 * Jumps into the Logs tab by time (no log line to point at): "Show in logs" for a request whose own line the
 * memory limit already dropped opens the moments around the request instead of giving up. Tiny on purpose: other
 * tabs import it without pulling in the Logs view. The Logs view takes the request when it is (or becomes)
 * visible, like `ui.focusLog`.
 */
export interface LogsMomentRequest {
  seq: number;
  /** The moment (epoch ms). */
  ts: number;
  /** Prefer lines of this device / app session around the moment. */
  deviceId?: string;
  appId?: string;
  /** Why there is no line to point at (worded by the Logs view). */
  reason: 'requestLineGone';
}

let pending: LogsMomentRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export const logsNav = {
  /** Open Logs around `ts` (±30 s, filters suspended for the view, like "Show in context"). */
  showMoment(ts: number, opts: { deviceId?: string; appId?: string; reason: LogsMomentRequest['reason'] }): void {
    pending = { seq: ++seq, ts, ...opts };
    emit();
    ui.setTab('logs');
  },
  /** Mark a request as handled (no-op when a newer one replaced it). */
  consume(s: number): void {
    if (pending?.seq !== s) return;
    pending = null;
    emit();
  },
  get(): LogsMomentRequest | null {
    return pending;
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useLogsMoment(): LogsMomentRequest | null {
  return useSyncExternalStore(logsNav.subscribe, logsNav.get, logsNav.get);
}
