import { describe, expect, it } from 'vitest';
import type { NetworkEntry } from '@durbun/protocol';
import { COLUMNS, DEFAULT_COLUMN_PREFS, DEFAULT_SORT, fitColumns, gridTemplate, minTableWidth, nextSort, sanitizeColumnPrefs, sanitizeSort, sortEntries, visibleColumns } from './columns';

const e = (id: string, p: Partial<NetworkEntry>): NetworkEntry =>
  ({ id, method: 'GET', host: 'h', path: '/', url: 'https://h/', source: 's', startTs: 0, state: 'complete', requestHeaders: [], hasRequestBody: false, hasResponseBody: false, deviceId: 'd', ...p }) as NetworkEntry;

describe('columns', () => {
  it('hides the source column by default and never hides the path', () => {
    expect(visibleColumns(DEFAULT_COLUMN_PREFS).map((c) => c.id)).not.toContain('source');
    expect(sanitizeColumnPrefs({ hidden: ['path', 'host', 'nope'], widths: { host: 5, path: 400, size: 'x' } })).toEqual({ hidden: ['host'], widths: { path: 400 } });
  });
  it('builds a grid template with a flexible path column', () => {
    const cols = COLUMNS.filter((c) => ['status', 'path', 'size'].includes(c.id));
    expect(gridTemplate(cols, { hidden: [], widths: { size: 90 } })).toBe('66px minmax(220px, 1fr) 90px');
    expect(minTableWidth(cols, { hidden: [], widths: {} })).toBe(66 + 220 + 80);
  });
  it('drops low-priority columns when the table is narrow', () => {
    const cols = visibleColumns(DEFAULT_COLUMN_PREFS);
    expect(fitColumns(cols, DEFAULT_COLUMN_PREFS, 0)).toHaveLength(cols.length);
    expect(fitColumns(cols, DEFAULT_COLUMN_PREFS, 5000)).toHaveLength(cols.length);
    expect(fitColumns(cols, DEFAULT_COLUMN_PREFS, 700).map((c) => c.id)).toEqual(['status', 'method', 'host', 'path', 'size', 'duration']);
    expect(fitColumns(cols, DEFAULT_COLUMN_PREFS, 300).map((c) => c.id)).toEqual(['status', 'method', 'path', 'duration']);
  });
});

describe('sorting', () => {
  it('cycles asc → desc → arrival order (size/duration start descending)', () => {
    expect(nextSort(DEFAULT_SORT, 'status')).toEqual({ key: 'status', dir: 'asc' });
    expect(nextSort({ key: 'status', dir: 'asc' }, 'status')).toEqual({ key: 'status', dir: 'desc' });
    expect(nextSort({ key: 'status', dir: 'desc' }, 'status')).toEqual(DEFAULT_SORT);
    expect(nextSort(DEFAULT_SORT, 'duration')).toEqual({ key: 'duration', dir: 'desc' });
    expect(sanitizeSort({ key: 'bogus', dir: 'up' })).toEqual(DEFAULT_SORT);
  });
  it('sorts by values, keeping arrival order for ties; pending durations sort last', () => {
    const list = [e('a', { duration: 30 }), e('b', { state: 'pending' }), e('c', { duration: 10 }), e('d', { duration: 30 })];
    expect(sortEntries(list, { key: 'duration', dir: 'asc' }).map((x) => x.id)).toEqual(['c', 'a', 'd', 'b']);
    expect(sortEntries(list, { key: 'seq', dir: 'desc' }).map((x) => x.id)).toEqual(['d', 'c', 'b', 'a']);
    const st = [e('a', { status: 500 }), e('b', { status: 200 }), e('c', { state: 'failed' }), e('d', { status: 404 })];
    expect(sortEntries(st, { key: 'status', dir: 'asc' }).map((x) => x.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});
