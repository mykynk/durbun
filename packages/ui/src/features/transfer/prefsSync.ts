/**
 * The UI's preferences live in this window's localStorage; the server keeps a copy so a backup (made by the
 * server, maybe while no window is open) carries them, and a package brings them to another Mac.
 * Window layout (panel sizes, the sidebar, the last tab) belongs to this Mac and is never sent.
 */
import { useEffect } from 'react';
import { api, isConnected, useConnection, usePrefs } from '../../data';
import { PREFS_STORAGE_KEY, PREFS_STORED_AT_LOAD, sanitizePrefs, type UiPrefs } from '../../data/stores/prefs';
import { readStorage } from '../../lib/persist';
import { t } from '../../i18n';
import { toast } from '../../components/Toast';

const PORTABLE = ['theme', 'language', 'logFontSize', 'density', 'timeFormat', 'wrapLines', 'showNetworkInLogs', 'hideNoise', 'noiseRules', 'highlightRules', 'notifyOnCrash'] as const;
type PortableKey = (typeof PORTABLE)[number];

const SYNC_DELAY_MS = 2_000;

/** The preferences that travel (packages, backups). */
export function uiPrefsSnapshot(): Pick<UiPrefs, PortableKey> {
  const s = usePrefs.getState();
  const out = {} as Record<PortableKey, unknown>;
  for (const k of PORTABLE) out[k] = s[k];
  return out as Pick<UiPrefs, PortableKey>;
}

/** Applies preferences from a package; anything malformed falls back to what this window has. */
export function applyUiPrefs(raw: Record<string, unknown>): void {
  const current = usePrefs.getState();
  const merged = sanitizePrefs({ ...current, ...raw });
  const patch: Partial<UiPrefs> = {};
  for (const k of PORTABLE) (patch as Record<string, unknown>)[k] = merged[k];
  current.updatePrefs(patch);
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
  if (keys.length === 0) return;
  const before: Record<string, unknown> = {};
  for (const k of keys) before[k] = current[k];
  current.updatePrefs(patch);
  toast.info(t('transfer.prefsRestore.title'), {
    description: t('transfer.prefsRestore.desc'),
    duration: 12_000,
    action: { label: t('transfer.prefsRestore.undo'), onClick: () => usePrefs.getState().updatePrefs(before as Partial<UiPrefs>) },
  });
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
      unsub = usePrefs.subscribe(schedule);
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
