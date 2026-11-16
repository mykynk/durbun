import { create } from 'zustand';
import { DEFAULT_SETTINGS, type MockRule, type ServerSettings } from '@durbun/protocol';
import { sendCommand } from '../commands';

/* ───────────── Mock rules ───────────── */

/** A save another window's change got in the way of (`mocks.conflict`). */
export interface MocksConflict {
  /** The list this window tried to save. */
  attempted: MockRule[];
  /** The server's list now (also in `rules`). */
  current: MockRule[];
  revision?: number;
}

export interface MocksState {
  rules: MockRule[];
  /** Received from the server at least once (snapshot or `mocks`). */
  loaded: boolean;
  /** Revision of `rules` on the server (undefined with a server that does not send one). */
  revision?: number;
  /**
   * Set when a save was refused because the rules changed elsewhere since this window loaded them. `rules`
   * already shows the server's list; the view offers "Reload" (`resolveMocksConflict('reload')`, keeps theirs) or
   * "Save mine anyway" (`resolveMocksConflict('overwrite')`). Cleared by either and by the next successful save.
   */
  conflict: MocksConflict | null;
}

export const useMocks = create<MocksState>()(() => ({ rules: [], loaded: false, conflict: null }));

export function setMocksFromServer(rules: MockRule[], revision?: number): void {
  useMocks.setState(typeof revision === 'number' ? { rules, loaded: true, revision } : { rules, loaded: true });
}

/** Is this a "changed elsewhere" refusal (mock rules, a flow, the environments)? */
export function isEditConflict(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'mocks.conflict' || code === 'flow.conflict' || code === 'env.conflict';
}

/**
 * Replace the whole rule list on the server (`mocks.set`). Applied optimistically; reverted when the
 * server rejects. Resolves with the server's canonical list. The save names the revision this window's rules
 * came from: when another window saved in between, it is refused (`CommandError` code `mocks.conflict`), the
 * store shows the server's list and `conflict` is set. `overwrite: true` saves without that check.
 */
export async function saveMocks(rules: MockRule[], opts: { overwrite?: boolean } = {}): Promise<MockRule[]> {
  const { rules: previous, revision } = useMocks.getState();
  useMocks.setState({ rules });
  try {
    const cmd = !opts.overwrite && typeof revision === 'number' ? { name: 'mocks.set' as const, rules, baseRevision: revision } : { name: 'mocks.set' as const, rules };
    const saved = await sendCommand(cmd);
    if (Array.isArray(saved)) useMocks.setState({ rules: saved });
    useMocks.setState({ conflict: null });
    return Array.isArray(saved) ? saved : rules;
  } catch (err) {
    const data = (err as { data?: unknown }).data as { rules?: unknown; revision?: unknown } | undefined;
    if (isEditConflict(err) && data && Array.isArray(data.rules)) {
      const current = data.rules as MockRule[];
      const rev = typeof data.revision === 'number' ? data.revision : undefined;
      useMocks.setState({ rules: current, ...(rev !== undefined ? { revision: rev } : {}), conflict: { attempted: rules, current, revision: rev } });
    } else useMocks.setState({ rules: previous });
    throw err;
  }
}

/** Settle a refused save: keep the server's rules, or save this window's list over them. */
export async function resolveMocksConflict(choice: 'reload' | 'overwrite'): Promise<MockRule[]> {
  const conflict = useMocks.getState().conflict;
  if (!conflict || choice === 'reload') {
    useMocks.setState({ conflict: null });
    return useMocks.getState().rules;
  }
  return saveMocks(conflict.attempted, { overwrite: true });
}

/* ───────────── Server settings ───────────── */

export interface ServerSettingsState {
  settings: ServerSettings;
  loaded: boolean;
  /**
   * Keys the server itself sent (the rest are the UI's defaults). An older server that does not know a setting
   * does not apply it either: e.g. no `iosDeviceLogScope` = every iPhone line is streamed.
   */
  reported?: ReadonlySet<string>;
}

export const useServerSettings = create<ServerSettingsState>()(() => ({ settings: DEFAULT_SETTINGS, loaded: false }));

export function setServerSettingsFromServer(settings: ServerSettings): void {
  useServerSettings.setState({ settings: { ...DEFAULT_SETTINGS, ...settings }, loaded: true, reported: new Set(Object.keys(settings ?? {})) });
}

/** `settings.update` (persisted & broadcast by the server). Optimistic; reverted on failure. */
export async function updateServerSettings(patch: Partial<ServerSettings>): Promise<ServerSettings> {
  const previous = useServerSettings.getState().settings;
  useServerSettings.setState({ settings: { ...previous, ...patch } });
  try {
    const next = await sendCommand({ name: 'settings.update', patch });
    if (next && typeof next === 'object') setServerSettingsFromServer(next);
    return useServerSettings.getState().settings;
  } catch (err) {
    useServerSettings.setState({ settings: previous });
    throw err;
  }
}
