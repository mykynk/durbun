import { create } from 'zustand';
import { DEFAULT_SETTINGS, type MockRule, type ServerSettings } from '@durbun/protocol';
import { sendCommand } from '../commands';

/* ───────────── Mock rules ───────────── */

export interface MocksState {
  rules: MockRule[];
  /** Received from the server at least once (snapshot or `mocks`). */
  loaded: boolean;
}

export const useMocks = create<MocksState>()(() => ({ rules: [], loaded: false }));

export function setMocksFromServer(rules: MockRule[]): void {
  useMocks.setState({ rules, loaded: true });
}

/**
 * Replace the whole rule list on the server (`mocks.set`). Applied optimistically; reverted when the
 * server rejects. Resolves with the server's canonical list.
 */
export async function saveMocks(rules: MockRule[]): Promise<MockRule[]> {
  const previous = useMocks.getState().rules;
  useMocks.setState({ rules });
  try {
    const saved = await sendCommand({ name: 'mocks.set', rules });
    if (Array.isArray(saved)) useMocks.setState({ rules: saved });
    return Array.isArray(saved) ? saved : rules;
  } catch (err) {
    useMocks.setState({ rules: previous });
    throw err;
  }
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
