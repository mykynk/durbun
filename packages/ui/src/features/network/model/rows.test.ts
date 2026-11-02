import { describe, expect, it } from 'vitest';
import type { NetworkEntry } from '@durbun/protocol';
import { NetworkStore } from '../../../data';
import { NetRowIndex } from './rows';

function entry(id: string, p: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    id,
    appId: p.appId ?? 'app:1',
    deviceId: 'demo:1',
    source: 'dart:io',
    method: 'GET',
    url: `https://api.pati.app/${id}`,
    host: 'api.pati.app',
    path: `/${id}`,
    startTs: 1,
    state: 'pending',
    requestHeaders: [],
    hasRequestBody: false,
    hasResponseBody: false,
    ...p,
  };
}

const errorsOnly = (e: NetworkEntry) => (e.status ?? 0) >= 400 || e.state === 'failed';
const all = () => true;

describe('NetRowIndex', () => {
  it('appends matching entries incrementally without rebuilding', () => {
    const store = new NetworkStore();
    const index = new NetRowIndex();
    store.upsert([entry('a'), entry('b')]);
    expect(index.sync(store, all)).toBe(true);
    expect(index.ids).toEqual(['a', 'b']);
    store.upsert([entry('c')]);
    expect(index.sync(store, all)).toBe(true);
    expect(index.ids).toEqual(['a', 'b', 'c']);
    expect(index.sync(store, all)).toBe(false);
    expect(index.rebuilds).toBe(1);
    expect(index.appended).toBe(1);
  });

  it('re-evaluates updated (dirty) entries and keeps arrival order', () => {
    const store = new NetworkStore();
    const index = new NetRowIndex();
    store.upsert([entry('a'), entry('b'), entry('c')]);
    index.sync(store, errorsOnly);
    expect(index.ids).toEqual([]);
    // c then a complete with errors
    store.upsert([entry('c', { state: 'complete', status: 500 })]);
    index.markDirty(['c']);
    index.sync(store, errorsOnly);
    expect(index.ids).toEqual(['c']);
    store.upsert([entry('a', { state: 'failed', error: 'x' }), entry('d', { state: 'complete', status: 404 })]);
    index.markDirty(['a', 'd']);
    index.sync(store, errorsOnly);
    expect(index.ids).toEqual(['a', 'c', 'd']);
    // a later succeeds after all (a late response upgrades a failed entry)
    store.upsert([entry('a', { state: 'complete', status: 200 })]);
    index.markDirty(['a']);
    index.sync(store, errorsOnly);
    expect(index.ids).toEqual(['c', 'd']);
    expect(index.rebuilds).toBe(1);
  });

  it('drops trimmed head entries in place when the store is at capacity', () => {
    const store = new NetworkStore();
    store.setMaxEntries(3);
    const index = new NetRowIndex();
    store.upsert([entry('a'), entry('b'), entry('c')]);
    index.sync(store, all);
    store.upsert([entry('d'), entry('e')]);
    index.sync(store, all);
    expect(index.ids).toEqual(['c', 'd', 'e']);
    expect(index.rebuilds).toBe(1);
  });

  it('handles scoped clears (removals in the middle) and full resets', () => {
    const store = new NetworkStore();
    const index = new NetRowIndex();
    store.upsert([entry('a', { appId: 'app:1' }), entry('b', { appId: 'app:2' }), entry('c', { appId: 'app:2' }), entry('d', { appId: 'app:1' })]);
    index.sync(store, all);
    store.removeWhere((e) => e.appId === 'app:2');
    index.sync(store, all);
    expect(index.ids).toEqual(['a', 'd']);
    expect(index.rebuilds).toBe(1); // the newest entry survived: pruned in place
    store.upsert([entry('e')]);
    index.sync(store, all);
    expect(index.ids).toEqual(['a', 'd', 'e']);
    store.removeWhere((e) => e.id === 'e');
    index.sync(store, all);
    expect(index.ids).toEqual(['a', 'd']);
    store.reset();
    store.upsert([entry('x')]);
    index.sync(store, all);
    expect(index.ids).toEqual(['x']);
  });

  it('rebuilds when the predicate changes or after invalidate()', () => {
    const store = new NetworkStore();
    const index = new NetRowIndex();
    store.upsert([entry('a', { state: 'complete', status: 404 }), entry('b', { state: 'complete', status: 200 })]);
    index.sync(store, all);
    expect(index.sync(store, errorsOnly)).toBe(true);
    expect(index.ids).toEqual(['a']);
    index.invalidate();
    index.sync(store, errorsOnly);
    expect(index.rebuilds).toBe(3);
  });

  it('keeps up with a long live stream at capacity without full rebuilds', () => {
    const store = new NetworkStore();
    store.setMaxEntries(500);
    const index = new NetRowIndex();
    index.sync(store, errorsOnly);
    for (let batch = 0; batch < 60; batch++) {
      const list: NetworkEntry[] = [];
      for (let k = 0; k < 20; k++) {
        const i = batch * 20 + k;
        list.push(entry(`r${i}`, i % 7 === 0 ? { state: 'complete', status: 500 } : {}));
      }
      store.upsert(list);
      index.sync(store, errorsOnly);
    }
    expect(store.size).toBe(500);
    const expected = store.order.filter((id) => Number(id.slice(1)) % 7 === 0);
    expect(index.ids).toEqual(expected);
    expect(index.rebuilds).toBe(1);
  });
});
