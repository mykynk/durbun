/**
 * The Mac app's own settings (update checks, open at login), read and written through its bridge
 * (`window.durbunDesktop.prefs`). A change made in the app's menus arrives as the 'prefs-changed' command and is
 * read again. In a browser or the CLI there is no bridge: `available` is false and Settings hides the rows.
 */
import { useCallback, useEffect, useState } from 'react';

export interface DesktopPrefs {
  /** null: the app has not asked the user yet (it asks on a later start). */
  autoUpdateCheck: boolean | null;
  openAtLogin: boolean;
  /** False outside the packaged app (a development run): the switch is shown off and disabled. */
  openAtLoginAvailable: boolean;
}

export interface DesktopPrefsPatch {
  autoUpdateCheck?: boolean;
  openAtLogin?: boolean;
}

interface PrefsBridge {
  get(): Promise<unknown>;
  set(patch: DesktopPrefsPatch): Promise<unknown>;
}

function bridge(): PrefsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const prefs = (window as unknown as { durbunDesktop?: { prefs?: Partial<PrefsBridge> } }).durbunDesktop?.prefs;
  return prefs && typeof prefs.get === 'function' && typeof prefs.set === 'function' ? (prefs as PrefsBridge) : undefined;
}

/** The bridge's reply, or undefined when it is not the expected shape (an older app). */
export function parseDesktopPrefs(v: unknown): DesktopPrefs | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const auto = o.autoUpdateCheck;
  if (auto !== null && typeof auto !== 'boolean') return undefined;
  if (typeof o.openAtLogin !== 'boolean') return undefined;
  return { autoUpdateCheck: auto, openAtLogin: o.openAtLogin, openAtLoginAvailable: o.openAtLoginAvailable !== false };
}

export function hasDesktopPrefs(): boolean {
  return !!bridge();
}

/**
 * Current values (undefined while loading or without a bridge), the setter (resolves to whether it worked) and
 * whether a write is in flight.
 */
export function useDesktopPrefs(): { available: boolean; prefs: DesktopPrefs | undefined; saving: boolean; set(patch: DesktopPrefsPatch): Promise<boolean> } {
  const available = hasDesktopPrefs();
  const [prefs, setPrefs] = useState<DesktopPrefs | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const b = bridge();
    if (!b) return;
    let alive = true;
    const load = () =>
      void b
        .get()
        .then((v) => {
          const p = parseDesktopPrefs(v);
          if (alive && p) setPrefs(p);
        })
        .catch(() => undefined);
    load();
    const onCommand = (e: Event) => {
      if ((e as CustomEvent<unknown>).detail === 'prefs-changed') load();
    };
    window.addEventListener('durbun:command', onCommand);
    return () => {
      alive = false;
      window.removeEventListener('durbun:command', onCommand);
    };
  }, []);

  const set = useCallback(async (patch: DesktopPrefsPatch): Promise<boolean> => {
    const b = bridge();
    if (!b) return false;
    setSaving(true);
    try {
      const p = parseDesktopPrefs(await b.set(patch));
      if (p) setPrefs(p);
      return !!p;
    } catch {
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  return { available, prefs, saving, set };
}
