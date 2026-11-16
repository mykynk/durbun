import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedFilter } from './queryEdit';

const f = (id: string, name: string, query: string): SavedFilter => ({ id, name, query });

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('saved log filters', () => {
  it('reads the filters saved before they travelled (same storage key), so nobody loses them', async () => {
    localStorage.setItem('durbun.state.logs.savedFilters', JSON.stringify([f('a', 'Errors', 'level:error'), { name: 42 }]));
    const { savedFilters } = await import('./savedFilters');
    expect(savedFilters()).toEqual([f('a', 'Errors', 'level:error')]);
  });

  it('writes changes back to the same key', async () => {
    const { setSavedFilters } = await import('./savedFilters');
    setSavedFilters([f('a', 'Errors', 'level:error')]);
    setSavedFilters((cur) => [...cur, f('b', 'Payments', 'tag:pay')]);
    expect(JSON.parse(localStorage.getItem('durbun.state.logs.savedFilters')!)).toEqual([f('a', 'Errors', 'level:error'), f('b', 'Payments', 'tag:pay')]);
  });

  it('adds incoming filters without duplicates; a taken name gets a number; nothing here is lost', async () => {
    const { mergeSavedFilters } = await import('./savedFilters');
    const mine = [f('a', 'Errors', 'level:error'), f('b', 'Payments', 'tag:pay')];
    const merged = mergeSavedFilters(mine, [f('x', 'errors', ' level:error '), f('b', 'Payments', 'tag:payment'), f('c', 'Slow', 'dur:>1s'), 'junk']);
    expect(merged.slice(0, 2)).toEqual(mine);
    expect(merged.map((x) => x.name)).toEqual(['Errors', 'Payments', 'Payments (2)', 'Slow']);
    // Ids stay unique.
    expect(new Set(merged.map((x) => x.id)).size).toBe(4);
    expect(mergeSavedFilters(mine, undefined)).toEqual(mine);
  });
});

describe('saved filters in the preference copy', () => {
  it('ride in the snapshot that backups and packages carry, and are added on import', async () => {
    const { setSavedFilters, savedFilters } = await import('./savedFilters');
    const { applyUiPrefs, uiPrefsSnapshot, SAVED_FILTERS_PREF } = await import('../../transfer/prefsSync');
    setSavedFilters([f('a', 'Errors', 'level:error')]);
    expect(uiPrefsSnapshot()[SAVED_FILTERS_PREF]).toEqual([f('a', 'Errors', 'level:error')]);
    applyUiPrefs({ [SAVED_FILTERS_PREF]: [f('z', 'Crashes', 'level:fatal')] });
    expect(savedFilters().map((x) => x.name)).toEqual(['Errors', 'Crashes']);
    // A package without filters leaves them alone.
    applyUiPrefs({ theme: 'dark' });
    expect(savedFilters()).toHaveLength(2);
  });

  it('are taken back from the server copy at a new address only when they add something', async () => {
    const { restoreFilters, SAVED_FILTERS_PREF } = await import('../../transfer/prefsSync');
    const mine = [f('a', 'Errors', 'level:error')];
    expect(restoreFilters({ [SAVED_FILTERS_PREF]: [f('a', 'Errors', 'level:error')] }, mine)).toBeNull();
    expect(restoreFilters({ theme: 'dark' }, mine)).toBeNull();
    expect(restoreFilters(null, mine)).toBeNull();
    expect(restoreFilters({ [SAVED_FILTERS_PREF]: [f('b', 'Slow', 'dur:>1s')] }, mine)?.map((x) => x.name)).toEqual(['Errors', 'Slow']);
  });
});
