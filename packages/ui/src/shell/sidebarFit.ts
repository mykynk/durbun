/**
 * The sidebar folds to its icon rail by itself while the window is tight (900–999 px; below 900 it is an overlay),
 * and opens again when there is room. The user's own choice wins: "collapsed" set on a wide window stays collapsed
 * everywhere, and opening (or closing) it by hand while the window is tight holds until the width crosses the
 * threshold again. That hand-made choice is not saved: the saved preference is the one for a wide window.
 */
import { create } from 'zustand';

export const TIGHT_QUERY = '(max-width: 999px)';

export interface SidebarFitState {
  /** The window is narrower than about 1000 px. */
  tight: boolean;
  /** The user opened ('open') or closed ('closed') it by hand while tight; null = follow the width. */
  override: 'open' | 'closed' | null;
}

function tightNow(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(TIGHT_QUERY).matches : false;
  } catch {
    return false;
  }
}

export const useSidebarFit = create<SidebarFitState>()(() => ({ tight: tightNow(), override: null }));

/** Whether the (non-overlay) sidebar shows as the icon rail. */
export function sidebarCompact(collapsedPref: boolean, fit: SidebarFitState): boolean {
  if (fit.override) return fit.override === 'closed';
  return collapsedPref || fit.tight;
}

/** The hook form of `sidebarCompact` (re-renders on width and preference changes). */
export function useSidebarCompact(collapsedPref: boolean): boolean {
  const fit = useSidebarFit();
  return sidebarCompact(collapsedPref, fit);
}

/**
 * Toggle by hand. Returns true when it was handled here (a tight window: a held choice, not a saved one); the
 * caller saves the preference otherwise.
 */
export function toggleTightSidebar(collapsedPref: boolean): boolean {
  const fit = useSidebarFit.getState();
  if (!fit.tight) return false;
  useSidebarFit.setState({ override: sidebarCompact(collapsedPref, fit) ? 'open' : 'closed' });
  return true;
}

/** Follow the window width (mount once). Crossing the threshold drops a held choice. */
export function initSidebarFit(): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const mql = window.matchMedia(TIGHT_QUERY);
  const sync = () => useSidebarFit.setState({ tight: mql.matches, override: null });
  useSidebarFit.setState({ tight: mql.matches });
  mql.addEventListener?.('change', sync);
  return () => mql.removeEventListener?.('change', sync);
}
