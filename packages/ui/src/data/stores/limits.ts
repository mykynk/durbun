import { create } from 'zustand';
import type { StoreEvictions, StoreLimits } from '@durbun/protocol';

/**
 * The server's store limits and what they deleted (hello / settings `limits`, snapshot / batch / cleared
 * `evictions`). Both stay null with a server that does not send them (the UI dev mock, older servers): then
 * `logStore.dropped` / `networkStore.dropped` count this window's own trims. Updates are coalesced: a batch
 * that changes nothing here does not re-render.
 */
export interface StoreLimitsState {
  limits: StoreLimits | null;
  evictions: StoreEvictions | null;
}

export const useStoreLimits = create<StoreLimitsState>()(() => ({ limits: null, evictions: null }));

export function setStoreLimits(limits: StoreLimits | undefined): void {
  if (limits) useStoreLimits.setState({ limits });
}

export function setStoreEvictions(evictions: StoreEvictions | null): void {
  useStoreLimits.setState({ evictions });
}
