import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type LogEntry, type NetworkEntry } from '@durbun/protocol';
import { handleServerMessage } from './dispatch';
import { LogStore, logStore } from './logStore';
import { networkStore } from './networkStore';
import { RowModel } from '../features/logs/model/rowModel';
import { rankOf, type RowFilter } from '../features/logs/model/types';

const PIXEL = 'android:R5CT20XK9QM';
let nextId = 1;
const row = (netId: string, p: Partial<LogEntry> = {}): LogEntry => ({
  id: nextId++,
  ts: 1,
  deviceId: PIXEL,
  appId: 'app:1',
  source: 'app',
  level: 'info',
  tag: 'http',
  kind: 'network',
  netId,
  message: `GET https://api.pati.app/v1/${netId}`,
  ...p,
});
const request = (id: string, p: Partial<NetworkEntry> = {}): NetworkEntry => ({
  id,
  appId: 'app:1',
  deviceId: PIXEL,
  source: 'dart:io',
  method: 'GET',
  url: `https://api.pati.app/v1/${id}`,
  host: 'api.pati.app',
  path: `/v1/${id}`,
  startTs: 1,
  state: 'pending',
  requestHeaders: [],
  hasRequestBody: false,
  hasResponseBody: false,
  ...p,
});
const errorsOnly = (): RowFilter => ({
  scope: () => true,
  minRank: rankOf('error'),
  queryMinRank: 0,
  sources: { device: true, app: true, system: true },
  hideNoise: false,
  noise: () => false,
  showNetwork: true,
  query: { test: () => true, matchesAll: true },
  dedupe: true,
  fold: true,
});

describe('a network row takes its request’s outcome level', () => {
  it('the store changes the row and its counts, and only when the level differs', () => {
    const store = new LogStore();
    const r = row('a');
    store.append([r]);
    expect(store.setNetworkLevel('a', 'info')).toBe(false);
    expect(store.levelRevision).toBe(0);
    expect(store.setNetworkLevel('a', 'error')).toBe(true);
    expect(store.getById(r.id)!.level).toBe('error');
    expect(store.getById(r.id)).not.toBe(r);
    expect(store.counts.error).toBe(1);
    expect(store.countsByApp.get('app:1')!.error).toBe(1);
    expect(store.setNetworkLevel('a', 'warn')).toBe(true);
    expect(store.counts).toMatchObject({ error: 0, warn: 1, total: 1 });
    expect(store.levelRevision).toBe(2);
    expect(store.setNetworkLevel('unknown', 'error')).toBe(false);
  });

  it('“errors only” shows a request that failed after its row arrived, and a late success takes it back out', () => {
    const store = new LogStore();
    const model = new RowModel();
    model.setFilter(errorsOnly());
    store.append([row('a'), row('b', { level: 'error', message: 'boom' })]);
    model.sync(store);
    const build = model.build;
    expect(model.count).toBe(1);

    store.setNetworkLevel('a', 'error');
    expect(model.sync(store)).toBe(true);
    expect(model.count).toBe(2);
    expect(model.row(0)!.e.level).toBe('error');
    // Not a new build: the view keeps its scroll position and selection.
    expect(model.build).toBe(build);

    store.setNetworkLevel('a', 'info');
    model.sync(store);
    expect(model.count).toBe(1);
    expect(model.row(0)!.e.message).toBe('boom');
  });
});

describe('live batches set the level (dispatch)', () => {
  beforeEach(() => {
    handleServerMessage({
      type: 'hello',
      server: { name: 'durbun', version: '0.2.0', protocol: 1, ports: { http: 9750, sdk: 9751 }, startedAt: 1, demo: false, lan: false, hostAddresses: [], dataDir: '/tmp', platform: 'darwin' },
      settings: DEFAULT_SETTINGS,
    });
    handleServerMessage({ type: 'snapshot', devices: [], apps: [], network: [], mocks: [], drivers: [], processes: [], metrics: [], logCount: 0 });
  });

  afterEach(() => {
    logStore.reset();
    networkStore.reset();
  });

  it('failed → error, 5xx → error, 4xx → warn, a success stays info; a pending update changes nothing', () => {
    const rows = [row('f'), row('s5'), row('s4'), row('ok'), row('p')];
    handleServerMessage({ type: 'batch', logs: rows, network: rows.map((r) => request(r.netId!)) });
    handleServerMessage({
      type: 'batch',
      network: [request('f', { state: 'failed', error: 'timeout' }), request('s5', { state: 'complete', status: 503 }), request('s4', { state: 'complete', status: 404 }), request('ok', { state: 'complete', status: 200 }), request('p')],
    });
    expect(rows.map((r) => logStore.getById(r.id)!.level)).toEqual(['error', 'error', 'warn', 'info', 'info']);
    expect(logStore.counts).toMatchObject({ error: 2, warn: 1 });
  });
});
