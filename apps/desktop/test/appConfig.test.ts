import { describe, expect, it } from 'vitest';
import { checkConfigPatch, configView, resolveConfig } from '../src/appConfig';

const defaults = { httpPort: 9750, sdkPort: 9751 };

describe('resolveConfig: environment > Settings > default', () => {
  it('ignores saved ports outside 1024–65535 (a hand-edited file)', () => {
    expect(resolveConfig({}, { httpPort: 80, sdkPort: 1023 }, defaults)).toMatchObject({ httpPort: 9750, sdkPort: 9751, source: { httpPort: 'default', sdkPort: 'default' } });
    expect(resolveConfig({}, { httpPort: 1024, sdkPort: 65_535 }, defaults)).toMatchObject({ httpPort: 1024, sdkPort: 65_535, source: { httpPort: 'file', sdkPort: 'file' } });
  });
  it('a variable may still use any port (a second copy, tests)', () => {
    expect(resolveConfig({ DURBUN_PORT: '80' }, {}, defaults)).toMatchObject({ httpPort: 80, source: { httpPort: 'env' } });
  });
  it('a saved port that lands on the other port gives way, the environment never does', () => {
    expect(resolveConfig({}, { httpPort: 9850, sdkPort: 9850 }, defaults)).toMatchObject({ httpPort: 9850, sdkPort: 9751, source: { sdkPort: 'default' } });
    expect(resolveConfig({ DURBUN_SDK_PORT: '9850' }, { httpPort: 9850 }, defaults)).toMatchObject({ httpPort: 9750, sdkPort: 9850, source: { httpPort: 'default', sdkPort: 'env' } });
  });
  it('DURBUN_DEBUG=0 / false turns verbose logging off over the saved choice; empty means unset', () => {
    expect(resolveConfig({ DURBUN_DEBUG: '0' }, { verboseLog: true }, defaults)).toMatchObject({ verbose: false, source: { verboseLog: 'env' } });
    expect(resolveConfig({ DURBUN_DEBUG: 'false' }, {}, defaults).verbose).toBe(false);
    expect(resolveConfig({ DURBUN_DEBUG: '' }, { verboseLog: true }, defaults)).toMatchObject({ verbose: true, source: { verboseLog: 'file' } });
    expect(resolveConfig({ DURBUN_DEBUG: 'yes' }, { verboseLog: false }, defaults).verbose).toBe(true);
  });
});

describe('configView: what Settings shows', () => {
  it('nothing is pending before the server started', () => {
    const v = configView({}, { httpPort: 9850 }, defaults, undefined);
    expect(v.restartNeeded).toBe(false);
    expect(v.httpPort).toEqual({ value: 9850, source: 'file', saved: 9850, default: 9750, env: 'DURBUN_PORT', pending: false });
    expect(v.listening).toEqual({ httpPort: null, sdkPort: null });
  });
  it('a saved change differs from what this run started with: restart needed, per field', () => {
    const started = { httpPort: 9750, sdkPort: 9751, verbose: false };
    const v = configView({}, { sdkPort: 9851 }, defaults, started, { httpPort: 9760, sdkPort: 9751 });
    expect(v.sdkPort).toMatchObject({ value: 9851, pending: true });
    expect(v.httpPort.pending).toBe(false); // runs on a fallback port (9760): that is not a pending change
    expect(v.verboseLog).toMatchObject({ value: false, source: 'default', saved: null, pending: false });
    expect(v.restartNeeded).toBe(true);
    expect(v.listening).toEqual({ httpPort: 9760, sdkPort: 9751 });
    expect(configView({}, {}, defaults, started).restartNeeded).toBe(false);
  });
  it('a variable wins over the saved value and says so', () => {
    const v = configView({ DURBUN_PORT: '9950' }, { httpPort: 9850 }, defaults, { httpPort: 9950, sdkPort: 9751, verbose: false });
    expect(v.httpPort).toMatchObject({ value: 9950, source: 'env', saved: 9850, pending: false });
  });
});

describe('checkConfigPatch', () => {
  it('sets, clears (null) and leaves the rest', () => {
    expect(checkConfigPatch({ httpPort: 9850, verboseLog: true }, {}, {}, defaults)).toEqual({ ok: true, prefs: { httpPort: 9850, verboseLog: true } });
    const cleared = checkConfigPatch({ sdkPort: null, verboseLog: null }, {}, { sdkPort: 9851, verboseLog: true }, defaults);
    expect(cleared).toEqual({ ok: true, prefs: { sdkPort: undefined, verboseLog: undefined } });
    expect(cleared.ok && 'sdkPort' in cleared.prefs).toBe(true); // the key is there: the store removes it
    expect(checkConfigPatch({ unknown: 1 }, {}, {}, defaults)).toEqual({ ok: true, prefs: {} });
  });
  it('ports are integers 1024–65535', () => {
    expect(checkConfigPatch({ httpPort: 80 }, {}, {}, defaults)).toEqual({ ok: false, error: 'invalidPort', field: 'httpPort' });
    expect(checkConfigPatch({ sdkPort: 65_536 }, {}, {}, defaults)).toEqual({ ok: false, error: 'invalidPort', field: 'sdkPort' });
    expect(checkConfigPatch({ sdkPort: 9751.5 }, {}, {}, defaults)).toEqual({ ok: false, error: 'invalidPort', field: 'sdkPort' });
    expect(checkConfigPatch({ httpPort: '9850' }, {}, {}, defaults)).toEqual({ ok: false, error: 'invalidValue', field: 'httpPort' });
    expect(checkConfigPatch({ verboseLog: 'yes' }, {}, {}, defaults)).toEqual({ ok: false, error: 'invalidValue', field: 'verboseLog' });
    expect(checkConfigPatch(null, {}, {}, defaults).ok).toBe(false);
    expect(checkConfigPatch([1], {}, {}, defaults).ok).toBe(false);
  });
  it('the two ports of the next start must differ, saved values and the environment included', () => {
    expect(checkConfigPatch({ httpPort: 9751 }, {}, {}, defaults)).toEqual({ ok: false, error: 'samePorts', field: 'httpPort' });
    expect(checkConfigPatch({ sdkPort: 9850 }, {}, { httpPort: 9850 }, defaults)).toEqual({ ok: false, error: 'samePorts', field: 'sdkPort' });
    expect(checkConfigPatch({ sdkPort: 9950 }, { DURBUN_PORT: '9950' }, {}, defaults)).toMatchObject({ ok: false, error: 'samePorts' });
    // Swapping both at once is fine.
    expect(checkConfigPatch({ httpPort: 9751, sdkPort: 9750 }, {}, {}, defaults).ok).toBe(true);
    // Clearing the HTTP port back to 9750 while the SDK port is saved as 9750 is not.
    expect(checkConfigPatch({ httpPort: null }, {}, { httpPort: 9850, sdkPort: 9750 }, defaults)).toMatchObject({ ok: false, error: 'samePorts' });
    // Verbose logging alone never trips over the ports.
    expect(checkConfigPatch({ verboseLog: true }, { DURBUN_PORT: '9751' }, {}, defaults).ok).toBe(true);
  });
});
