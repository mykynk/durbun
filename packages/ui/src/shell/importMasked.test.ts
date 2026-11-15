import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import '../features/transfer/i18n';
import { setLanguage } from '../i18n/core';
import { toast } from '../components';
import { importFile } from './actions';

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ deviceIds: ['import:1'] })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setLanguage('en');
});

const recording = (masked: boolean) =>
  new File([`{"format":"durbun-session","version":1,"devices":[],"logs":[],"network":[]${masked ? ',"masked":true' : ''}}`], 'kumbara.durbun.json', { type: 'application/json' });

describe('importing a recording says when its secrets are masked', () => {
  it('a masked file: the result says the •••• are masks', async () => {
    setLanguage('en');
    const success = vi.spyOn(toast, 'success');
    await importFile(recording(true));
    expect(success).toHaveBeenCalledTimes(1);
    expect((success.mock.calls[0]![1] as { description: string }).description).toBe('kumbara.durbun.json · Secret values in this recording are masked as ••••.');
  });

  it('a raw file: just its name (Turkish too)', async () => {
    setLanguage('tr');
    const success = vi.spyOn(toast, 'success');
    await importFile(recording(false));
    expect((success.mock.calls[0]![1] as { description: string }).description).toBe('kumbara.durbun.json');
    await importFile(recording(true));
    expect((success.mock.calls[1]![1] as { description: string }).description).toMatch(/gizli değerler •••• olarak maskeli/);
  });
});
