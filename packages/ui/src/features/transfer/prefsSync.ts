/**
 * The UI's preferences live in this window's localStorage; the server keeps a copy so a backup (made by the
 * server, maybe while no window is open) carries them, and a package brings them to another Mac.
 * Window layout (panel sizes, the sidebar, the last tab) belongs to this Mac and is never sent.
 */
import { useEffect } from 'react';
import { api, isConnected, useConnection, usePrefs } from '../../data';
import { sanitizePrefs, type UiPrefs } from '../../data/stores/prefs';

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

/** Keeps the server's copy current: after changes (debounced) and whenever the connection comes back. */
export function useUiPrefsSync(): void {
  const connected = isConnected(useConnection((s) => s.status));
  useEffect(() => {
    if (!connected) return;
    let last = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
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
    schedule();
    const unsub = usePrefs.subscribe(schedule);
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [connected]);
}
