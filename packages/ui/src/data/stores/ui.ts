import { create } from 'zustand';
import type { MockRule } from '@durbun/protocol';
import { TAB_IDS, usePrefs, type TabId } from './prefs';

export type SettingsSection = 'appearance' | 'logs' | 'network' | 'connection' | 'about';
export type SdkGuideTab = 'flutter' | 'android' | 'ios' | 'react-native';

/** Global (non-persisted) UI state: active tab and which global screens are open. */
export interface UiState {
  tab: TabId;
  palette: boolean;
  shortcuts: boolean;
  settings: SettingsSection | null;
  doctor: boolean;
  sdkGuide: SdkGuideTab | null;
  /** Narrow layout (< 900 px): sidebar is an overlay. */
  narrow: boolean;
  /** Sidebar overlay open (narrow layout only). */
  sidebarOverlay: boolean;
  /**
   * Pending cross-feature navigation ("show this in tab X"). The target view handles it once — scroll to /
   * select / open — and then calls `ui.consumeFocus(focus.seq)`. Views that are not mounted yet handle it on
   * mount, so always check it in an effect keyed on `focus?.seq`.
   */
  focus: UiFocus | null;
}

/** A mock rule being created from elsewhere (e.g. "Mock oluştur" on a request) — not saved yet. */
export type MockRuleDraft = Omit<MockRule, 'id' | 'createdAt'>;

export type UiFocus =
  /** Logs tab: select + scroll to this log id (clear filters that hide it, like "show in context"). */
  | { kind: 'log'; logId: number; seq: number }
  /** Network tab: select this request and open its detail. */
  | { kind: 'network'; netId: string; seq: number }
  /** Mocks tab: select / open this saved rule. */
  | { kind: 'mock'; ruleId: string; seq: number }
  /** Mocks tab: open the editor pre-filled with a new, unsaved rule. */
  | { kind: 'mockDraft'; draft: MockRuleDraft; seq: number };

let focusSeq = 0;

function tabFromHash(): TabId | null {
  try {
    const h = typeof location !== 'undefined' ? location.hash.replace(/^#\/?/, '') : '';
    return (TAB_IDS as readonly string[]).includes(h) ? (h as TabId) : null;
  } catch {
    return null;
  }
}

export const useUi = create<UiState>()(() => ({
  tab: tabFromHash() ?? usePrefs.getState().lastTab,
  palette: false,
  shortcuts: false,
  settings: null,
  doctor: false,
  sdkGuide: null,
  narrow: typeof window !== 'undefined' ? window.innerWidth < 900 : false,
  sidebarOverlay: false,
  focus: null,
}));

export const ui = {
  setTab(tab: TabId): void {
    if (!(TAB_IDS as readonly string[]).includes(tab)) return;
    useUi.setState({ tab });
    usePrefs.getState().setPref('lastTab', tab);
    try {
      if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
    } catch {
      /* ignore */
    }
  },
  openPalette: () => useUi.setState({ palette: true }),
  closePalette: () => useUi.setState({ palette: false }),
  togglePalette: () => useUi.setState((s) => ({ palette: !s.palette })),
  openShortcuts: () => useUi.setState({ shortcuts: true, palette: false }),
  closeShortcuts: () => useUi.setState({ shortcuts: false }),
  openSettings: (section: SettingsSection = 'appearance') => useUi.setState({ settings: section, palette: false }),
  closeSettings: () => useUi.setState({ settings: null }),
  openDoctor: () => useUi.setState({ doctor: true, palette: false }),
  closeDoctor: () => useUi.setState({ doctor: false }),
  openSdkGuide: (tab: SdkGuideTab = 'flutter') => useUi.setState({ sdkGuide: tab, palette: false }),
  closeSdkGuide: () => useUi.setState({ sdkGuide: null }),
  setSidebarOverlay: (open: boolean) => useUi.setState({ sidebarOverlay: open }),

  /** Switch to Logs and select/scroll to the log row with this id. */
  focusLog(logId: number): void {
    ui.setTab('logs');
    useUi.setState({ focus: { kind: 'log', logId, seq: ++focusSeq } });
  },
  /** Switch to Network and open this request. */
  focusNetwork(netId: string): void {
    ui.setTab('network');
    useUi.setState({ focus: { kind: 'network', netId, seq: ++focusSeq } });
  },
  /** Switch to Mocks and open this saved rule. */
  focusMock(ruleId: string): void {
    ui.setTab('mocks');
    useUi.setState({ focus: { kind: 'mock', ruleId, seq: ++focusSeq } });
  },
  /** Switch to Mocks and open the editor with a new, unsaved rule. */
  newMockFromDraft(draft: MockRuleDraft): void {
    ui.setTab('mocks');
    useUi.setState({ focus: { kind: 'mockDraft', draft, seq: ++focusSeq } });
  },
  /** Mark a focus request as handled (no-op when a newer request replaced it). */
  consumeFocus(seq: number): void {
    if (useUi.getState().focus?.seq === seq) useUi.setState({ focus: null });
  },
};

/** Keep the tab in sync with back/forward navigation of the URL hash. */
export function initHashSync(): () => void {
  const onHash = () => {
    const tab = tabFromHash();
    if (tab && tab !== useUi.getState().tab) useUi.setState({ tab });
  };
  window.addEventListener('hashchange', onHash);
  return () => window.removeEventListener('hashchange', onHash);
}
