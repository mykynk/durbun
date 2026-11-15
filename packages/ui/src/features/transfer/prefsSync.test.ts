import { describe, expect, it } from 'vitest';
import { defaultPrefs, type UiPrefs } from '../../data/stores/prefs';
import { restorePatch } from './prefsSync';

const prefs = (patch: Partial<UiPrefs> = {}): UiPrefs => ({ ...defaultPrefs(), language: 'tr', ...patch });

describe('restoring the server copy at a new address', () => {
  it('takes the portable preferences that differ', () => {
    const server = { theme: 'dark', language: 'tr', hideNoise: true, highlightRules: [{ id: 'h', pattern: 'pay', regex: false, caseSensitive: false, color: 'red', enabled: true }] };
    const patch = restorePatch(server, prefs());
    expect(patch).toEqual({ theme: 'dark', hideNoise: true, highlightRules: server.highlightRules });
  });

  it('never takes the window layout or malformed values', () => {
    expect(restorePatch({ lastTab: 'flows', panelSizes: { logs: 500 }, sidebarCollapsed: true, theme: 'neon' }, prefs())).toEqual({});
  });

  it('has nothing to take from an empty or odd copy', () => {
    expect(restorePatch({}, prefs())).toEqual({});
    expect(restorePatch(null, prefs())).toEqual({});
    expect(restorePatch([1, 2], prefs())).toEqual({});
  });
});
