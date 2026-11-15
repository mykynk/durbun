import { afterEach, describe, expect, it } from 'vitest';
import { defaultPrefs, flushPrefs, mergePrefsWrite, sharedPrefsChange, usePrefs, type UiPrefs } from './prefs';

const KEY = 'durbun.prefs.v1';
const prefs = (patch: Partial<UiPrefs> = {}): UiPrefs => ({ ...defaultPrefs(), language: 'en', ...patch });

describe('prefs shared by several windows', () => {
  afterEach(() => {
    localStorage.clear();
    usePrefs.getState().resetPrefs();
  });

  it('writes only the keys this window changed over what another window stored', () => {
    const stored = { ...prefs({ theme: 'dark', logFontSize: 14 }) };
    const out = mergePrefsWrite(stored, prefs(), prefs({ wrapLines: true }));
    expect(out).toMatchObject({ theme: 'dark', logFontSize: 14, wrapLines: true });
  });

  it('writes nothing when nothing changed', () => {
    expect(mergePrefsWrite(prefs({ theme: 'dark' }), prefs(), prefs())).toBeNull();
  });

  it('merges panel sizes per pane, removals included', () => {
    const stored = prefs({ panelSizes: { logs: 300, net: 420, flows: 200 } });
    const before = prefs({ panelSizes: { logs: 280, flows: 200 } });
    const after = prefs({ panelSizes: { logs: 320 } });
    expect(mergePrefsWrite(stored, before, after)?.panelSizes).toEqual({ logs: 320, net: 420 });
  });

  it('starts from this window’s values when nothing is stored', () => {
    expect(mergePrefsWrite(null, prefs(), prefs({ density: 'comfortable' }))).toMatchObject({ density: 'comfortable', theme: 'system' });
  });

  it('follows another window’s shared preferences but keeps this window’s layout', () => {
    const current = prefs({ lastTab: 'network', panelSizes: { logs: 300 } });
    const patch = sharedPrefsChange(prefs({ theme: 'light', lastTab: 'flows', panelSizes: { logs: 500 }, sidebarCollapsed: true }), current);
    expect(patch).toEqual({ theme: 'light' });
  });

  it('ignores keys another window did not store and malformed values', () => {
    expect(sharedPrefsChange({ theme: 'neon' }, prefs())).toEqual({});
    expect(sharedPrefsChange({ hideNoise: true }, prefs())).toEqual({ hideNoise: true });
    expect(sharedPrefsChange(null, prefs())).toEqual({});
  });

  it('keeps another window’s newer choice when this window saves its own', () => {
    usePrefs.getState().setPref('wrapLines', true);
    // Another window turned the theme dark in the meantime.
    const other = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    localStorage.setItem(KEY, JSON.stringify({ ...other, theme: 'dark' }));
    flushPrefs();
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}')).toMatchObject({ theme: 'dark', wrapLines: true });
  });

  it('applies a storage event from another window', () => {
    usePrefs.getState().setPref('lastTab', 'perf');
    flushPrefs();
    const newValue = JSON.stringify({ ...prefs(), timeFormat: 'delta', lastTab: 'device' });
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue }));
    expect(usePrefs.getState().timeFormat).toBe('delta');
    expect(usePrefs.getState().lastTab).toBe('perf');
  });
});
