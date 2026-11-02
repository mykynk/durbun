import { create } from 'zustand';
import { detectLanguage, type Lang } from '../../i18n/core';
import { readStorage, writeStorage } from '../../lib/persist';

export type ThemePref = 'system' | 'dark' | 'light';
export type Density = 'compact' | 'comfortable';
export type TimeFormat = 'absolute' | 'relative' | 'delta';
export type TabId = 'logs' | 'network' | 'mocks' | 'perf' | 'device';
export const TAB_IDS: readonly TabId[] = ['logs', 'network', 'mocks', 'perf', 'device'];

/** Hides known-noisy system lines when `hideNoise` is on (SPEC §1.1-4). Editable by the user. */
export interface NoiseRule {
  id: string;
  field: 'tag' | 'process' | 'message';
  match: 'exact' | 'prefix' | 'contains';
  value: string;
  enabled: boolean;
}

export type HighlightColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'violet' | 'pink';
export const HIGHLIGHT_COLORS: readonly HighlightColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'violet', 'pink'];

/** User highlight rule for log rows (CSS color token: `var(--pick-<color>)`). */
export interface HighlightRule {
  id: string;
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  color: HighlightColor;
  enabled: boolean;
}

export interface UiPrefs {
  theme: ThemePref;
  language: Lang;
  /** 11–16 px (CSS var --log-fs). */
  logFontSize: number;
  density: Density;
  timeFormat: TimeFormat;
  wrapLines: boolean;
  showNetworkInLogs: boolean;
  hideNoise: boolean;
  noiseRules: NoiseRule[];
  highlightRules: HighlightRule[];
  notifyOnCrash: boolean;
  sidebarCollapsed: boolean;
  /** SplitPane sizes by pane id (px). */
  panelSizes: Record<string, number>;
  /** Last active tab (used when the URL has no #tab). */
  lastTab: TabId;
}

const NOISY_TAGS = [
  'chatty',
  'OpenGLRenderer',
  'InputMethodManager',
  'InsetsController',
  'ImeTracker',
  'BLASTBufferQueue',
  'SurfaceFlinger',
  'SurfaceComposerClient',
  'Gralloc4',
  'gralloc4',
  'EGL_emulation',
  'HostConnection',
  'libEGL',
  'CompatibilityChangeReporter',
  'AutofillManager',
  'ProfileInstaller',
  'FrameEvents',
  'InputTransport',
  'AdrenoGLES-0',
  'TrafficStats',
];

export const DEFAULT_NOISE_RULES: NoiseRule[] = [
  ...NOISY_TAGS.map((tag, i): NoiseRule => ({ id: `noise-${i}`, field: 'tag', match: 'exact', value: tag, enabled: true })),
  // Android 10+: "ViewRootImpl@3f2a[MainActivity]", "VRI[MainActivity]"
  { id: 'noise-viewroot', field: 'tag', match: 'prefix', value: 'ViewRootImpl', enabled: true },
  { id: 'noise-vri', field: 'tag', match: 'prefix', value: 'VRI[', enabled: true },
  // iOS simulator: Apple frameworks' subsystems
  { id: 'noise-apple', field: 'tag', match: 'prefix', value: 'com.apple.', enabled: true },
];

export function defaultPrefs(): UiPrefs {
  return {
    theme: 'system',
    language: detectLanguage(),
    logFontSize: 12.5,
    density: 'compact',
    timeFormat: 'absolute',
    wrapLines: false,
    showNetworkInLogs: true,
    hideNoise: false,
    noiseRules: DEFAULT_NOISE_RULES,
    highlightRules: [],
    notifyOnCrash: false,
    sidebarCollapsed: false,
    panelSizes: {},
    lastTab: 'logs',
  };
}

const STORAGE_KEY = 'prefs.v1';

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Merge persisted data over defaults, dropping anything malformed. */
export function sanitizePrefs(raw: unknown): UiPrefs {
  const d = defaultPrefs();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const fs = typeof r.logFontSize === 'number' && Number.isFinite(r.logFontSize) ? r.logFontSize : d.logFontSize;
  const sizes: Record<string, number> = {};
  if (r.panelSizes && typeof r.panelSizes === 'object') {
    for (const [k, v] of Object.entries(r.panelSizes as Record<string, unknown>)) if (typeof v === 'number' && Number.isFinite(v) && v > 0) sizes[k] = v;
  }
  return {
    theme: pick(r.theme, ['system', 'dark', 'light'] as const, d.theme),
    language: pick(r.language, ['tr', 'en'] as const, d.language),
    logFontSize: Math.min(16, Math.max(11, Math.round(fs * 2) / 2)),
    density: pick(r.density, ['compact', 'comfortable'] as const, d.density),
    timeFormat: pick(r.timeFormat, ['absolute', 'relative', 'delta'] as const, d.timeFormat),
    wrapLines: bool(r.wrapLines, d.wrapLines),
    showNetworkInLogs: bool(r.showNetworkInLogs, d.showNetworkInLogs),
    hideNoise: bool(r.hideNoise, d.hideNoise),
    noiseRules: Array.isArray(r.noiseRules)
      ? (r.noiseRules as unknown[]).filter(
          (x): x is NoiseRule =>
            !!x &&
            typeof (x as NoiseRule).id === 'string' &&
            typeof (x as NoiseRule).value === 'string' &&
            ['tag', 'process', 'message'].includes((x as NoiseRule).field) &&
            ['exact', 'prefix', 'contains'].includes((x as NoiseRule).match),
        )
      : d.noiseRules,
    highlightRules: Array.isArray(r.highlightRules)
      ? (r.highlightRules as unknown[]).filter(
          (x): x is HighlightRule =>
            !!x && typeof (x as HighlightRule).id === 'string' && typeof (x as HighlightRule).pattern === 'string' && HIGHLIGHT_COLORS.includes((x as HighlightRule).color),
        )
      : d.highlightRules,
    notifyOnCrash: bool(r.notifyOnCrash, d.notifyOnCrash),
    sidebarCollapsed: bool(r.sidebarCollapsed, d.sidebarCollapsed),
    panelSizes: sizes,
    lastTab: pick(r.lastTab, TAB_IDS, d.lastTab),
  };
}

export interface PrefsActions {
  setPref<K extends keyof UiPrefs>(key: K, value: UiPrefs[K]): void;
  updatePrefs(patch: Partial<UiPrefs>): void;
  setPanelSize(id: string, size: number | undefined): void;
  resetPrefs(): void;
}

export type PrefsState = UiPrefs & PrefsActions;

/** UI preferences, persisted to localStorage (`durbun.prefs.v1`). */
export const usePrefs = create<PrefsState>()((set) => ({
  ...sanitizePrefs(readStorage<unknown>(STORAGE_KEY, null)),
  setPref: (key, value) => set({ [key]: value } as Partial<PrefsState>),
  updatePrefs: (patch) => set(patch),
  setPanelSize: (id, size) =>
    set((s) => {
      const panelSizes = { ...s.panelSizes };
      if (size === undefined) delete panelSizes[id];
      else panelSizes[id] = Math.round(size);
      return { panelSizes };
    }),
  resetPrefs: () => set({ ...defaultPrefs(), language: usePrefs.getState().language }),
}));

export function getPrefs(): UiPrefs {
  return usePrefs.getState();
}

function snapshot(s: PrefsState): UiPrefs {
  return {
    theme: s.theme,
    language: s.language,
    logFontSize: s.logFontSize,
    density: s.density,
    timeFormat: s.timeFormat,
    wrapLines: s.wrapLines,
    showNetworkInLogs: s.showNetworkInLogs,
    hideNoise: s.hideNoise,
    noiseRules: s.noiseRules,
    highlightRules: s.highlightRules,
    notifyOnCrash: s.notifyOnCrash,
    sidebarCollapsed: s.sidebarCollapsed,
    panelSizes: s.panelSizes,
    lastTab: s.lastTab,
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
usePrefs.subscribe((state) => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeStorage(STORAGE_KEY, snapshot(state));
  }, 150);
});

/** Write pending prefs immediately (e.g. on pagehide). */
export function flushPrefs(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  writeStorage(STORAGE_KEY, snapshot(usePrefs.getState()));
}
