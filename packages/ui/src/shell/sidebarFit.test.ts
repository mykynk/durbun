import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePrefs } from '../data/stores/prefs';
import { useUi } from '../data/stores/ui';
import { toggleSidebar } from './actions';
import { initSidebarFit, sidebarCompact, useSidebarFit } from './sidebarFit';

afterEach(() => {
  useSidebarFit.setState({ tight: false, override: null });
  usePrefs.getState().setPref('sidebarCollapsed', false);
  useUi.setState({ narrow: false, sidebarOverlay: false });
  vi.unstubAllGlobals();
});

describe('sidebar fit', () => {
  it('folds by itself on a tight window and opens again when there is room', () => {
    expect(sidebarCompact(false, { tight: false, override: null })).toBe(false);
    expect(sidebarCompact(false, { tight: true, override: null })).toBe(true);
    // Collapsed on purpose stays collapsed on a wide window.
    expect(sidebarCompact(true, { tight: false, override: null })).toBe(true);
  });

  it('the user’s own choice wins while tight, without saving it', () => {
    useSidebarFit.setState({ tight: true, override: null });
    toggleSidebar();
    expect(useSidebarFit.getState().override).toBe('open');
    expect(sidebarCompact(usePrefs.getState().sidebarCollapsed, useSidebarFit.getState())).toBe(false);
    expect(usePrefs.getState().sidebarCollapsed).toBe(false);
    toggleSidebar();
    expect(sidebarCompact(usePrefs.getState().sidebarCollapsed, useSidebarFit.getState())).toBe(true);
  });

  it('on a wide window the toggle is the saved preference', () => {
    toggleSidebar();
    expect(usePrefs.getState().sidebarCollapsed).toBe(true);
    expect(useSidebarFit.getState().override).toBeNull();
  });

  it('crossing the threshold drops a held choice', () => {
    let listener: (() => void) | undefined;
    const mql = { matches: true, addEventListener: (_: string, fn: () => void) => (listener = fn), removeEventListener: () => undefined };
    vi.stubGlobal('matchMedia', () => mql);
    const stop = initSidebarFit();
    expect(useSidebarFit.getState().tight).toBe(true);
    useSidebarFit.setState({ override: 'open' });
    mql.matches = false;
    listener?.();
    expect(useSidebarFit.getState()).toEqual({ tight: false, override: null });
    stop();
  });
});
