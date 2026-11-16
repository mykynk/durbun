import { useSyncExternalStore } from 'react';
import { ui } from '../../data';

/**
 * Opens the Network tab filtered to the requests one mock rule answered ("12 hits" on a rule). Tiny on purpose:
 * the Mocks tab imports it without pulling in the Network view, which takes the request when it is (or becomes)
 * visible, like `ui.focusNetwork`.
 */
export interface NetworkMockHitsRequest {
  seq: number;
  ruleId: string;
}

let pending: NetworkMockHitsRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export const networkNav = {
  showMockHits(ruleId: string): void {
    pending = { seq: ++seq, ruleId };
    emit();
    ui.setTab('network');
  },
  consume(s: number): void {
    if (pending?.seq !== s) return;
    pending = null;
    emit();
  },
  get(): NetworkMockHitsRequest | null {
    return pending;
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useNetworkMockHits(): NetworkMockHitsRequest | null {
  return useSyncExternalStore(networkNav.subscribe, networkNav.get, networkNav.get);
}
