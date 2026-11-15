import { describe, expect, it } from 'vitest';
import type { LogEntry, NetworkEntry } from '@durbun/protocol';
import { LogStore } from './logStore';
import { NetworkStore } from './networkStore';

let nextId = 1;
const line = (p: Partial<LogEntry> = {}): LogEntry => ({ id: nextId++, ts: 1, deviceId: 'android:1', source: 'app', level: 'info', tag: 't', message: 'm', ...p });
const request = (id: string): NetworkEntry => ({
  id,
  deviceId: 'android:1',
  source: 'dart:io',
  method: 'GET',
  url: `https://api.example.com/${id}`,
  host: 'api.example.com',
  path: `/${id}`,
  startTs: 1,
  state: 'complete',
  requestHeaders: [],
  hasRequestBody: false,
  hasResponseBody: false,
});

describe('rows the memory limit deleted (the "older lines were removed" note)', () => {
  it('logs: counts what is really gone, not crash records moved aside; reset starts over', () => {
    const store = new LogStore();
    store.setMaxEntries(4);
    store.append([line(), line({ kind: 'crash', level: 'fatal' }), line(), line(), line(), line()]);
    // 6 lines, 4 fit: the crash is kept aside (keptCap 2), two plain lines are gone.
    expect(store.size).toBe(4);
    expect(store.dropped).toBe(2);
    store.append([line()]);
    expect(store.dropped).toBe(3);
    store.reset();
    expect(store.dropped).toBe(0);
  });

  it('network: counts the oldest requests the limit deleted; updates of a known request do not count', () => {
    const store = new NetworkStore();
    store.setMaxEntries(2);
    store.upsert([request('a'), request('b')]);
    store.upsert([{ ...request('b'), status: 200 }]);
    expect(store.dropped).toBe(0);
    store.upsert([request('c'), request('d')]);
    expect(store.dropped).toBe(2);
    expect(store.order).toEqual(['c', 'd']);
    store.reset();
    expect(store.dropped).toBe(0);
  });
});
