/**
 * The UI's preferences live in this window's localStorage; the server keeps a copy so a backup (made by the
 * server, maybe while no window is open) carries them, and a package brings them to another Mac.
 * Window layout (panel sizes, the sidebar, the last tab) belongs to this Mac and is never sent.
 * The saved log filters travel with them under `logSavedFilters` (their own store: features/logs/model/savedFilters);
 * filters that come in are added to the ones here, never put in their place.
 */
import { useEffect } from 'react';
import { api, isConnected, useConnection, usePrefs } from '../../data';
import { PREFS_STORAGE_KEY, PREFS_STORED_AT_LOAD, sanitizePrefs, type UiPrefs } from '../../data/stores/prefs';
import { readStorage } from '../../lib/persist';
import { t } from '../../i18n';
import { toast } from '../../components/Toast';
import { mergeSavedFilters, savedFilters, setSavedFilters, useSavedFilters } from '../logs/model/savedFilters';
import type { SavedFilter } from '../logs/model/queryEdit';

const PORTABLE = ['theme', 'language', 'logFontSize', 'density', 'timeFormat', 'wrapLines', 'showNetworkInLogs', 'hideNoise', 'noiseRules', 'highlightRules', 'notifyOnCrash'] as const;
type PortableKey = (typeof PORTABLE)[number];

const SYNC_DELAY_MS = 2_000;

/** Where the saved log filters ride in the preference copy. */
export const SAVED_FILTERS_PREF = 'logSavedFilters';

export type PortablePrefs = Pick<UiPrefs, PortableKey> & { [SAVED_FILTERS_PREF]: SavedFilter[] };

/** The preferences that travel (packages, backups), with the saved log filters. */
export function uiPrefsSnapshot(): PortablePrefs {
  const s = usePrefs.getState();
  const out = {} as Record<string, unknown>;
  for (const k of PORTABLE) out[k] = s[k];
  out[SAVED_FILTERS_PREF] = savedFilters();
  return out as PortablePrefs;
}

/** Applies preferences from a package; anything malformed falls back to what this window has. Saved filters are added. */
export function applyUiPrefs(raw: Record<string, unknown>): void {
  const current = usePrefs.getState();
  const merged = sanitizePrefs({ ...current, ...raw });
  const patch: Partial<UiPrefs> = {};
  for (const k of PORTABLE) (patch as Record<string, unknown>)[k] = merged[k];
  current.updatePrefs(patch);
  if (SAVED_FILTERS_PREF in raw) setSavedFilters((cur) => mergeSavedFilters(cur, raw[SAVED_FILTERS_PREF]));
}

const samePrefs = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The server's copy as a change to this window: the portable keys it has that differ from `current`.
 * Nothing when the copy is empty or malformed.
 */
export function restorePatch(server: unknown, current: UiPrefs): Partial<Pick<UiPrefs, PortableKey>> {
  if (!server || typeof server !== 'object' || Array.isArray(server)) return {};
  const raw = server as Record<string, unknown>;
  const merged = sanitizePrefs({ ...current, ...raw });
  const patch: Record<string, unknown> = {};
  for (const k of PORTABLE) if (k in raw && !samePrefs(merged[k], current[k])) patch[k] = merged[k];
  return patch as Partial<Pick<UiPrefs, PortableKey>>;
}

/**
 * Once per page, at a new address (no stored preferences at load): the server's copy is taken back, with
 * a toast and Undo. Skipped when the user already changed something here or another window stored
 * preferences meanwhile; that window's choice reaches this one through the storage event.
 */
async function restoreFromServer(atLoad: string): Promise<void> {
  if (JSON.stringify(uiPrefsSnapshot()) !== atLoad) return;
  let server: unknown;
  try {
    server = await api.getUiPrefs();
  } catch {
    return;
  }
  const current = usePrefs.getState();
  if (JSON.stringify(uiPrefsSnapshot()) !== atLoad || readStorage<unknown>(PREFS_STORAGE_KEY, null) !== null) return;
  const patch = restorePatch(server, current);
  const keys = Object.keys(patch) as PortableKey[];
  const filtersBefore = savedFilters();
  const filters = restoreFilters(server, filtersBefore);
  if (keys.length === 0 && !filters) return;
  const before: Record<string, unknown> = {};
  for (const k of keys) before[k] = current[k];
  if (keys.length) current.updatePrefs(patch);
  if (filters) setSavedFilters(filters);
  toast.info(t('transfer.prefsRestore.title'), {
    description: t('transfer.prefsRestore.desc'),
    duration: 12_000,
    action: {
      label: t('transfer.prefsRestore.undo'),
      onClick: () => {
        if (keys.length) usePrefs.getState().updatePrefs(before as Partial<UiPrefs>);
        if (filters) setSavedFilters(filtersBefore);
      },
    },
  });
}

/** The saved filters after taking the server's copy back, or null when it adds nothing. */
export function restoreFilters(server: unknown, current: readonly SavedFilter[]): SavedFilter[] | null {
  if (!server || typeof server !== 'object' || Array.isArray(server)) return null;
  const raw = (server as Record<string, unknown>)[SAVED_FILTERS_PREF];
  if (raw === undefined) return null;
  const merged = mergeSavedFilters(current, raw);
  return merged.length === current.length ? null : merged;
}

const snapshotAtLoad = JSON.stringify(uiPrefsSnapshot());
let restoring: Promise<void> | null = PREFS_STORED_AT_LOAD ? Promise.resolve() : null;

/** Keeps the server's copy current: after changes (debounced) and whenever the connection comes back. */
export function useUiPrefsSync(): void {
  const connected = isConnected(useConnection((s) => s.status));
  useEffect(() => {
    if (!connected) return;
    let last = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    const push = () => {
      timer = null;
      const snap = uiPrefsSnapshot();
      const text = JSON.stringify(snap);
      if (text === last) return;
      last = text;
      api.putUiPrefs(snap).catch(() => {
        last = '';
      });
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(push, SYNC_DELAY_MS);
    };
    // At a new address the defaults must not be sent over the server's copy before it is read.
    let unsub = () => {};
    const start = () => {
      if (!alive) return;
      schedule();
      const offPrefs = usePrefs.subscribe(schedule);
      const offFilters = useSavedFilters.subscribe(schedule);
      unsub = () => {
        offPrefs();
        offFilters();
      };
    };
    restoring ??= restoreFromServer(snapshotAtLoad).catch(() => undefined);
    void restoring.then(start);
    return () => {
      alive = false;
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [connected]);
}
