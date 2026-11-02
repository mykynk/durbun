import { createContext, useContext } from 'react';
import type { TabId } from '../data/stores/prefs';

export interface FeatureContextValue {
  tab: TabId;
  /** True while this feature's tab is the visible one. */
  active: boolean;
}

export const FeatureContext = createContext<FeatureContextValue>({ tab: 'logs', active: true });

/**
 * Features stay mounted after their first visit (scroll positions survive tab switches) but are hidden
 * while another tab is active. Use this to pause expensive work while hidden:
 *   const active = useFeatureActive();
 *   useLogVersion({ enabled: active });
 *   useShortcut('Space', toggle, { enabled: active });
 */
export function useFeatureActive(): boolean {
  return useContext(FeatureContext).active;
}

export function useFeatureTab(): TabId {
  return useContext(FeatureContext).tab;
}
