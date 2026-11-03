import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import { RowModel, canFold } from './rowModel';
import type { RowFilter, StoreView } from './types';

/** Minimal in-memory store with the logStore semantics the model relies on. */
class FakeStore implements StoreView {
  entries: LogEntry[] = [];
  generation = 0;
  lastId = 0;
  private nextId = 1;
  add(partial: Partial<LogEntry> & { message: string }): LogEntry {
    const e: LogEntry = { id: this.nextId++, ts: 1_700_000_000_000 + this.nextId * 10, deviceId: 'demo:1', source: 'device', level: 'info', tag: 'app', ...partial };
    this.entries.push(e);
    this.lastId = e.id;
    return e;
  }
  trimHead(n: number): void {
    this.entries.splice(0, n);
  }
  reset(): void {
    this.entries = [];
    this.generation++;
    this.lastId = 0;
  }
  lowerBound(id: number): number {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.entries[mid]!.id < id) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

function filter(over: Partial<RowFilter> = {}): RowFilter {
  return {
    scope: () => true,
    minRank: 0,
    queryMinRank: 0,
    sources: { device: true, app: true, system: true },
    hideNoise: false,
    noise: () => false,
    showNetwork: true,
    query: { test: () => true, matchesAll: true },
    dedupe: true,
    fold: true,
    ...over,
  };
}

function setup(over: Partial<RowFilter> = {}) {
  const store = new FakeStore();
  const model = new RowModel();
  model.setFilter(filter(over));
  return { store, model };
}

const messages = (m: RowModel) => m.rows.slice(m.start).map((r) => r.e.message);

describe('RowModel: incremental rows', () => {
  it('appends only new entries on each sync and bumps the version', () => {
    const { store, model } = setup();
    store.add({ message: 'a' });
    store.add({ message: 'b' });
    expect(model.sync(store)).toBe(true);
    expect(messages(model)).toEqual(['a', 'b']);
    const v = model.version;
    expect(model.sync(store)).toBe(false);
    expect(model.version).toBe(v);
    store.add({ message: 'c' });
    model.sync(store);
    expect(messages(model)).toEqual(['a', 'b', 'c']);
    expect(model.appended).toBe(3);
  });

  it('rebuilds from scratch when the store generation changes', () => {
    const { store, model } = setup();
    store.add({ message: 'a' });
    model.sync(store);
    store.reset();
    store.add({ message: 'x' });
    model.sync(store);
    expect(messages(model)).toEqual(['x']);
  });

  it('rebuilds when the filter object changes', () => {
    const { store, model } = setup();
    store.add({ message: 'keep', level: 'error' });
    store.add({ message: 'drop', level: 'debug' });
    model.sync(store);
    expect(model.count).toBe(2);
    const build = model.build;
    model.setFilter(filter({ minRank: 4 }));
    model.sync(store);
    expect(model.build).toBe(build + 1);
    expect(messages(model)).toEqual(['keep']);
  });

  it('drops rows of entries trimmed from the store head with a start pointer', () => {
    const { store, model } = setup();
    for (let i = 0; i < 10; i++) store.add({ message: `m${i}` });
    model.sync(store);
    const structure = model.structure;
    store.trimHead(4);
    store.add({ message: 'm10' });
    model.sync(store);
    expect(messages(model)).toEqual(['m4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10']);
    expect(model.start).toBeGreaterThan(0);
    expect(model.structure).toBeGreaterThan(structure);
  });

  it('handles a drop of everything (ring wrapped while hidden)', () => {
    const { store, model } = setup();
    for (let i = 0; i < 5; i++) store.add({ message: `old${i}` });
    model.sync(store);
    store.trimHead(5);
    store.add({ message: 'new' });
    model.sync(store);
    expect(messages(model)).toEqual(['new']);
    expect(model.counts.device).toBe(1);
  });

  it('keeps lifecycle separators and markers visible regardless of the min-level control', () => {
    const { store, model } = setup({ minRank: 4 });
    store.add({ message: 'noise', level: 'info' });
    store.add({ message: 'App connected', source: 'system', kind: 'lifecycle', code: 'app.connected', tag: 'durbun' });
    store.add({ message: 'Marker 1', source: 'system', kind: 'marker', code: 'marker', tag: 'durbun', deviceId: '' });
    store.add({ message: 'boom', level: 'error' });
    model.sync(store);
    expect(messages(model)).toEqual(['App connected', 'Marker 1', 'boom']);
  });

  it('counts visible markers so a scope with only global markers can show its empty state', () => {
    const { store, model } = setup();
    store.add({ message: 'Marker 1', source: 'system', kind: 'marker', code: 'marker', tag: 'durbun', deviceId: '' });
    model.sync(store);
    expect(model.counts.markers).toBe(1);
    expect(model.count).toBe(1);
    store.trimHead(1);
    store.add({ message: 'x' });
    model.sync(store);
    expect(model.counts.markers).toBe(0);
  });

  it('applies the query level hint to every line (structural ones too)', () => {
    const { store, model } = setup({ queryMinRank: 4 });
    store.add({ message: 'App connected', source: 'system', kind: 'lifecycle' });
    store.add({ message: 'boom', level: 'fatal' });
    model.sync(store);
    expect(messages(model)).toEqual(['boom']);
  });

  it('hides network rows when showNetwork is off', () => {
    const { store, model } = setup({ showNetwork: false });
    store.add({ message: 'GET https://x', kind: 'network', netId: 'app:1:1', tag: 'network', source: 'system' });
    store.add({ message: 'text' });
    model.sync(store);
    expect(messages(model)).toEqual(['text']);
  });
});

describe('RowModel: folding identical consecutive lines', () => {
  it('folds identical lines into ×N and keeps the latest occurrence', () => {
    const { store, model } = setup();
    store.add({ message: 'tick' });
    const second = store.add({ message: 'tick' });
    model.sync(store);
    expect(model.count).toBe(1);
    const row = model.row(0)!;
    expect(row.n).toBe(2);
    expect(row.last).toBe(second);
    // a third one arriving later replaces the row object (memoized rows re-render)
    store.add({ message: 'tick' });
    model.sync(store);
    expect(model.row(0)).not.toBe(row);
    expect(model.row(0)!.n).toBe(3);
    expect(model.appended).toBe(1);
  });

  it('does not fold different tags, levels, sources or processes', () => {
    // dedupe off: the app/device pairs below would otherwise be merged as duplicates (same text)
    const { store, model } = setup({ dedupe: false });
    store.add({ message: 'x', tag: 'a' });
    store.add({ message: 'x', tag: 'b' });
    store.add({ message: 'x', tag: 'b', level: 'warn' });
    store.add({ message: 'x', tag: 'b', level: 'warn', source: 'app' });
    store.add({ message: 'x', tag: 'b', level: 'warn', source: 'app', process: 'p' });
    model.sync(store);
    expect(model.count).toBe(5);
  });

  it('never folds crashes, events, separators or lines with payloads', () => {
    const { store, model } = setup();
    store.add({ message: 'boom', kind: 'crash', level: 'fatal' });
    store.add({ message: 'boom', kind: 'crash', level: 'fatal' });
    store.add({ message: 'purchase', kind: 'event', data: { v: 1 } });
    store.add({ message: 'purchase', kind: 'event', data: { v: 2 } });
    store.add({ message: 'p', data: { a: 1 } });
    store.add({ message: 'p', data: { a: 1 } });
    model.sync(store);
    expect(model.count).toBe(6);
  });

  it('can be switched off', () => {
    const { store, model } = setup({ fold: false });
    store.add({ message: 'tick' });
    store.add({ message: 'tick' });
    model.sync(store);
    expect(model.count).toBe(2);
  });

  it('canFold compares the identity fields', () => {
    const base: LogEntry = { id: 1, ts: 0, deviceId: 'd', source: 'device', level: 'info', tag: 't', message: 'm' };
    expect(canFold(base, { ...base, id: 2 })).toBe(true);
    expect(canFold(base, { ...base, id: 2, deviceId: 'other' })).toBe(false);
    expect(canFold(base, { ...base, id: 2, message: 'm2' })).toBe(false);
  });
});

describe('RowModel: app-vs-device duplicates', () => {
  const box = '══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞══\nA RenderFlex overflowed by 38 pixels on the right.\n════';

  it('hides the device copy that arrives after the app line and marks the app row', () => {
    const { store, model } = setup();
    const ts = 1_700_000_000_000;
    store.add({ message: box, source: 'app', tag: 'flutter', level: 'error', kind: 'flutter-error', ts, appId: 'app:1' });
    store.add({ message: box, source: 'device', tag: 'flutter', level: 'error', kind: 'flutter-error', ts });
    model.sync(store);
    expect(model.count).toBe(1);
    expect(model.row(0)!.e.source).toBe('app');
    expect(model.row(0)!.twin).toBe(true);
    // both still count towards the source badges
    expect(model.counts.app).toBe(1);
    expect(model.counts.device).toBe(1);
    expect(model.hist.total).toBe(1);
  });

  it('removes an already shown device copy when the app line arrives second', () => {
    const { store, model } = setup();
    const ts = 1_700_000_000_000;
    store.add({ message: 'flutter: hello', source: 'device', tag: 'flutter', ts });
    model.sync(store);
    expect(model.count).toBe(1);
    store.add({ message: 'hello', source: 'app', tag: 'flutter', ts: ts + 500 });
    model.sync(store);
    expect(model.count).toBe(1);
    expect(model.row(0)!.e.source).toBe('app');
    expect(model.row(0)!.twin).toBe(true);
    expect(model.hist.total).toBe(1);
  });

  it('shows both copies when dedupe is off (the app row is still marked)', () => {
    const { store, model } = setup({ dedupe: false });
    const ts = 1_700_000_000_000;
    store.add({ message: 'same', source: 'app', ts });
    store.add({ message: 'same', source: 'device', ts });
    model.sync(store);
    expect(model.count).toBe(2);
    expect(model.row(0)!.twin).toBe(true);
  });

  it('pairs 1:1 and only within ±2 s on the same device', () => {
    const { store, model } = setup();
    const ts = 1_700_000_000_000;
    store.add({ message: 'x', source: 'app', ts });
    store.add({ message: 'x', source: 'device', ts: ts + 1000 });
    store.add({ message: 'x', source: 'device', ts: ts + 1100 }); // second device copy: no partner left
    store.add({ message: 'y', source: 'app', ts });
    store.add({ message: 'y', source: 'device', ts: ts + 5000 }); // too late
    store.add({ message: 'z', source: 'app', ts });
    store.add({ message: 'z', source: 'device', ts, deviceId: 'demo:2' }); // other device
    model.sync(store);
    expect(messages(model)).toEqual(['x', 'x', 'y', 'y', 'z', 'z']);
  });

  it('pairs a Flutter SDK crash with the engine line the device log prints for it', () => {
    const { store, model } = setup();
    const ts = 1_700_000_000_000;
    store.add({
      message: 'Unhandled exception: Null check operator used on a null value',
      source: 'app',
      kind: 'crash',
      level: 'fatal',
      tag: 'zone',
      ts,
      error: { type: '_TypeError', message: 'Null check operator used on a null value', stack: '#0      main (package:pati/main.dart:1:1)' },
    });
    store.add({
      message: '[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: Null check operator used on a null value\n#0      main (package:pati/main.dart:1:1)',
      source: 'device',
      level: 'error',
      tag: 'flutter',
      ts,
    });
    model.sync(store);
    expect(model.count).toBe(1);
    expect(model.row(0)!.e.source).toBe('app');
    expect(model.row(0)!.twin).toBe(true);
  });

  it('pairs an Android SDK crash with the AndroidRuntime FATAL EXCEPTION group (device copy first)', () => {
    const { store, model } = setup();
    const ts = 1_700_000_000_000;
    store.add({
      message: 'FATAL EXCEPTION: main\nProcess: com.example.app, PID: 6612\njava.lang.IllegalStateException: Fragment BasketFragment{4a1c2e9} (2b3c) not attached\n\tat androidx.fragment.app.Fragment.requireContext(Fragment.java:972)',
      source: 'device',
      kind: 'crash',
      level: 'fatal',
      tag: 'AndroidRuntime',
      ts,
    });
    model.sync(store);
    expect(model.count).toBe(1);
    store.add({
      message: 'java.lang.IllegalStateException: Fragment BasketFragment{4a1c2e9} not attached to a context.',
      source: 'app',
      kind: 'crash',
      level: 'fatal',
      tag: 'AndroidRuntime',
      ts: ts + 300,
      error: { type: 'java.lang.IllegalStateException', message: 'Fragment BasketFragment{4a1c2e9} not attached to a context.' },
    });
    model.sync(store);
    expect(model.count).toBe(1);
    expect(model.row(0)!.e.source).toBe('app');
    expect(model.row(0)!.twin).toBe(true);
  });

  it('keeps two different crashes of the same moment apart', () => {
    const { store, model } = setup();
    const ts = 1_700_000_000_000;
    store.add({ message: 'Unhandled exception: A', source: 'app', kind: 'crash', level: 'fatal', ts });
    store.add({ message: '[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: B', source: 'device', level: 'error', tag: 'flutter', ts });
    model.sync(store);
    expect(model.count).toBe(2);
    expect(model.row(0)!.twin).toBeUndefined();
  });

  it('keeps the device copy when the app source is switched off', () => {
    const { store, model } = setup({ sources: { device: true, app: false, system: true } });
    const ts = 1_700_000_000_000;
    store.add({ message: 'only once', source: 'app', ts });
    store.add({ message: 'only once', source: 'device', ts });
    model.sync(store);
    expect(model.count).toBe(1);
    expect(model.row(0)!.e.source).toBe('device');
  });
});

describe('RowModel: counters and noise', () => {
  it('counts per source including disabled sources, and the noise lines it hides', () => {
    const noisy = (e: LogEntry) => e.tag === 'chatty';
    const { store, model } = setup({ sources: { device: true, app: false, system: true }, noise: noisy, hideNoise: true });
    store.add({ message: 'n1', tag: 'chatty' });
    store.add({ message: 'n2', tag: 'chatty' });
    store.add({ message: 'd' });
    store.add({ message: 'a', source: 'app' });
    store.add({ message: 's', source: 'system', kind: 'lifecycle' });
    model.sync(store);
    expect(model.counts).toEqual({ device: 1, app: 1, system: 1, noise: 2, markers: 0 });
    expect(messages(model)).toEqual(['d', 's']);
  });

  it('counts noise without hiding it when hideNoise is off', () => {
    const { store, model } = setup({ noise: (e) => e.tag === 'chatty' });
    store.add({ message: 'n1', tag: 'chatty' });
    store.add({ message: 'n2', tag: 'chatty', level: 'warn' });
    model.sync(store);
    expect(model.counts.noise).toBe(2);
    expect(model.counts.device).toBe(2);
    expect(model.count).toBe(2);
  });

  it('subtracts counters and histogram buckets for trimmed entries', () => {
    const { store, model } = setup({ noise: (e) => e.tag === 'chatty' });
    store.add({ message: 'n', tag: 'chatty' });
    store.add({ message: 'e', level: 'error' });
    store.add({ message: 'a', source: 'app' });
    model.sync(store);
    expect(model.counts).toEqual({ device: 2, app: 1, system: 0, noise: 1, markers: 0 });
    expect(model.hist.total).toBe(3);
    store.trimHead(2);
    model.sync(store);
    expect(model.counts).toEqual({ device: 0, app: 1, system: 0, noise: 0, markers: 0 });
    expect(model.hist.total).toBe(1);
  });

  it('does not put previous-launch crashes into the histogram', () => {
    const { store, model } = setup();
    store.add({ message: 'Crash in previous launch: boom', kind: 'crash', level: 'fatal', data: { previousLaunch: true }, ts: 1 });
    model.sync(store);
    expect(model.count).toBe(1);
    expect(model.hist.total).toBe(0);
  });
});

describe('RowModel: lookups and pause', () => {
  it('finds rows by key, by entry (inside folds), nearest and by time', () => {
    const { store, model } = setup();
    const a = store.add({ message: 'a', ts: 100 });
    const b1 = store.add({ message: 'b', ts: 200 });
    const b2 = store.add({ message: 'b', ts: 300 });
    const hidden = store.add({ message: 'h', source: 'app', ts: 350 });
    const c = store.add({ message: 'c', ts: 400 });
    model.setFilter(filter({ sources: { device: true, app: false, system: true } }));
    model.sync(store);
    expect(model.count).toBe(3);
    expect(model.indexOfRow(a.id)).toBe(0);
    expect(model.indexOfRow(b2.id)).toBe(-1);
    expect(model.indexOfEntry(b2.id)).toBe(1);
    expect(model.indexOfEntry(hidden.id)).toBe(-1);
    expect(model.nearestIndex(hidden.id)).toBe(2);
    expect(model.row(model.nearestIndex(hidden.id))!.id).toBe(c.id);
    expect(model.indexAtTime(250)).toBe(2);
    expect(model.indexAtTime(0)).toBe(0);
    expect(b1.id).toBe(model.row(1)!.id);
  });

  it('counts pending lines while frozen without building rows', () => {
    const { store, model } = setup({ minRank: 3 });
    store.add({ message: 'w', level: 'warn' });
    model.sync(store);
    store.add({ message: 'skip', level: 'info' });
    store.add({ message: 'e1', level: 'error' });
    store.add({ message: 'e2', level: 'error' });
    expect(model.countPending(store)).toBe(2);
    expect(model.count).toBe(1);
    store.add({ message: 'e3', level: 'error' });
    expect(model.countPending(store)).toBe(3);
    model.sync(store);
    expect(messages(model)).toEqual(['w', 'e1', 'e2', 'e3']);
  });

  it('keeps 200 000 entries cheap to process incrementally', () => {
    const { store, model } = setup({ noise: (e) => e.tag === 'chatty' });
    for (let i = 0; i < 200_000; i++) store.add({ message: i % 7 === 0 ? 'same' : `line ${i}`, tag: i % 5 === 0 ? 'chatty' : 'app', level: i % 50 === 0 ? 'error' : 'info' });
    const t0 = performance.now();
    model.sync(store);
    const full = performance.now() - t0;
    expect(model.count).toBeGreaterThan(150_000);
    store.add({ message: 'one more' });
    const t1 = performance.now();
    model.sync(store);
    const incremental = performance.now() - t1;
    expect(incremental).toBeLessThan(5);
    // generous bound for CI machines; typically ~40–80 ms
    expect(full).toBeLessThan(2000);
  });

  it('hides device crash records the server matched to a live crash (data.duplicateOf), unless de-duplication is off', () => {
    const live = { message: 'FATAL EXCEPTION: main\nProcess: com.mykynk.kumbara, PID: 12873\njava.lang.IllegalStateException: sepet boş', kind: 'crash' as const, level: 'fatal' as const, origin: 'logcat' as const, pid: 12873 };
    const record = {
      message: 'Process: com.mykynk.kumbara\nPID: 12873\njava.lang.IllegalStateException: sepet boş',
      kind: 'crash' as const,
      level: 'fatal' as const,
      tag: 'data_app_crash',
      origin: 'dropbox' as const,
      data: { origin: 'dropbox', package: 'com.mykynk.kumbara', process: 'com.mykynk.kumbara', pid: 12873, reportTs: 1, previousLaunch: false, duplicateOf: 1 },
    };
    const older = { ...record, data: { origin: 'dropbox', package: 'com.mykynk.kumbara', reportTs: 0, previousLaunch: true } };
    const on = setup();
    on.store.add(live);
    on.store.add(record);
    on.store.add(older);
    on.model.sync(on.store);
    expect(on.model.rows.map((r) => r.e.tag)).toEqual(['app', 'data_app_crash']);
    expect((on.model.rows[1]!.e.data as { previousLaunch: boolean }).previousLaunch).toBe(true);
    const off = setup({ dedupe: false });
    off.store.add(live);
    off.store.add(record);
    off.model.sync(off.store);
    expect(off.model.rows).toHaveLength(2);
  });
});

describe('RowModel: a flapping device connection', () => {
  const sep = (code: string, ts: number, deviceId = 'ios:1') => ({ message: code, source: 'system' as const, kind: 'lifecycle' as const, code, ts, deviceId, tag: 'durbun' });

  it('merges repeated disconnect / connect / stream separators of one device into one row at the newest event', () => {
    const { store, model } = setup();
    let ts = 1_700_000_000_000;
    for (let i = 0; i < 6; i++) {
      store.add(sep('device.disconnected', (ts += 3000)));
      store.add({ message: `line ${i}`, deviceId: 'demo:1', ts: ts + 1 });
      store.add(sep('device.connected', (ts += 2000)));
      store.add(sep('logs.streamStarted', (ts += 500)));
    }
    model.sync(store);
    const seps = model.rows.slice(model.start).filter((r) => r.e.source === 'system');
    // Without merging: 18 full-width separator rows.
    expect(seps).toHaveLength(1);
    const row = seps[0]!;
    expect(row.flap?.events.map((e) => e.code).filter((c) => c === 'device.disconnected')).toHaveLength(6);
    expect(row.e.code).toBe('logs.streamStarted');
    // Different events, not repeats: no ×N (export, copy and the detail panel read `flap.events`).
    expect(row.n).toBe(1);
    expect(row.id).toBe(row.e.id);
    expect(row.flap?.key).toBe(row.flap?.events[0]!.id);
    // The merged row is the newest row; the other device's lines keep their own rows in order.
    const last = model.rows[model.rows.length - 1]!;
    expect(last).toBe(row);
    expect(messages(model).filter((m) => m.startsWith('line '))).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4', 'line 5']);
    const ids = model.rows.slice(model.start).map((r) => r.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('keeps a normal connect, a drop that did not come back and groups farther apart than the gap as plain separators', () => {
    const { store, model } = setup();
    const t0 = 1_700_000_000_000;
    store.add(sep('device.connected', t0));
    store.add(sep('logs.streamStarted', t0 + 400));
    store.add(sep('device.disconnected', t0 + 120_000));
    store.add(sep('device.connected', t0 + 300_000));
    model.sync(store);
    expect(model.rows.slice(model.start).map((r) => [r.e.code, r.flap ? r.flap.events.length : 0])).toEqual([
      ['device.connected', 0],
      ['logs.streamStarted', 0],
      ['device.disconnected', 0],
      ['device.connected', 0],
    ]);
  });

  it('leaves a requested log-stream restart as its two neutral separators', () => {
    const { store, model } = setup();
    const t0 = 1_700_000_000_000;
    store.add(sep('device.connected', t0));
    store.add(sep('logs.streamStarted', t0 + 400));
    store.add(sep('logs.streamStopped', t0 + 9000));
    store.add(sep('logs.streamStarted', t0 + 9400));
    store.add(sep('logs.streamStopped', t0 + 15_000));
    store.add(sep('logs.streamStarted', t0 + 15_400));
    model.sync(store);
    expect(model.rows.slice(model.start).map((r) => [r.e.code, r.flap ? r.flap.events.length : 0])).toEqual([
      ['device.connected', 0],
      ['logs.streamStarted', 0],
      ['logs.streamStopped', 0],
      ['logs.streamStarted', 0],
      ['logs.streamStopped', 0],
      ['logs.streamStarted', 0],
    ]);
    // A log stream that failed is a fault: it merges like a drop.
    store.add({ ...sep('logs.streamError', t0 + 20_000), level: 'warn' });
    store.add(sep('logs.streamStarted', t0 + 23_000));
    model.sync(store);
    expect(model.rows[model.rows.length - 1]!.flap?.events.map((e) => e.code).slice(-2)).toEqual(['logs.streamError', 'logs.streamStarted']);
  });

  it('groups per device, leaves app separators alone and shows every separator when folding is off', () => {
    const add = (store: InstanceType<typeof FakeStore>) => {
      const t0 = 1_700_000_000_000;
      store.add(sep('device.disconnected', t0, 'ios:1'));
      store.add(sep('device.disconnected', t0 + 100, 'android:2'));
      store.add({ ...sep('app.disconnected', t0 + 200, 'ios:1'), appId: 'app:1' });
      store.add(sep('device.connected', t0 + 3000, 'ios:1'));
      store.add(sep('device.connected', t0 + 3100, 'android:2'));
    };
    const on = setup();
    add(on.store);
    on.model.sync(on.store);
    expect(on.model.rows.map((r) => `${r.e.deviceId} ${r.e.code} ${r.flap?.events.length ?? 1}`)).toEqual([
      'ios:1 app.disconnected 1',
      'ios:1 device.connected 2',
      'android:2 device.connected 2',
    ]);
    const off = setup({ fold: false });
    add(off.store);
    off.model.sync(off.store);
    expect(off.model.rows).toHaveLength(5);
    expect(off.model.rows.some((r) => r.flap)).toBe(false);
  });

  it('keeps merging across syncs and survives the store trimming the group’s first events', () => {
    const { store, model } = setup();
    const t0 = 1_700_000_000_000;
    store.add(sep('device.disconnected', t0));
    store.add(sep('device.connected', t0 + 1000));
    model.sync(store);
    expect(model.count).toBe(1);
    store.trimHead(1);
    store.add(sep('device.disconnected', t0 + 5000));
    store.add(sep('device.connected', t0 + 6000));
    model.sync(store);
    expect(model.count).toBe(1);
    expect(model.row(0)!.flap?.events).toHaveLength(4);
  });
});

describe('RowModel: the device’s own record of a live crash', () => {
  it('hands the matched dropbox / .ips record to the live crash row (de-duplication on or off)', () => {
    for (const dedupe of [true, false]) {
      const { store, model } = setup({ dedupe });
      const live = store.add({ message: 'Fatal signal 11 (SIGSEGV)', kind: 'crash', level: 'fatal', origin: 'idevicesyslog' });
      store.add({ message: 'other line' });
      model.sync(store);
      const rec = store.add({
        message: 'Kumbara 3.1.0 (310) crashed: EXC_BAD_ACCESS (SIGSEGV)',
        kind: 'crash',
        level: 'fatal',
        origin: 'crash-report',
        data: { origin: 'crash-report', version: '3.1.0', build: '310', reportUrl: '/api/files/crash/u/Runner.ips', duplicateOf: live.id },
      });
      model.sync(store);
      const row = model.rows[model.indexOfRow(live.id) + model.start]!;
      expect(row.rec).toBe(rec);
      expect(model.rows.some((r) => r.e === rec)).toBe(!dedupe);
    }
  });

  it('gives the record to the app row when its live device line was hidden as that row’s twin', () => {
    for (const deviceFirst of [false, true]) {
      const { store, model } = setup();
      const ts = 1_700_000_000_000;
      const sdk = () =>
        store.add({
          message: 'Uncaught exception NSInvalidArgumentException: -[__NSArrayM objectAtIndex:]: index 3 beyond bounds',
          source: 'app',
          kind: 'crash',
          level: 'fatal',
          ts,
          error: { type: 'NSInvalidArgumentException', message: 'index 3 beyond bounds' },
        });
      const dev = () =>
        store.add({
          message: "*** Terminating app due to uncaught exception 'NSInvalidArgumentException', reason: '-[__NSArrayM objectAtIndex:]: index 3 beyond bounds'",
          kind: 'crash',
          level: 'fatal',
          origin: 'idevicesyslog',
          process: 'Runner',
          pid: 811,
          ts: ts + 300,
        });
      const live = deviceFirst ? dev() : (sdk(), dev());
      if (deviceFirst) sdk();
      const ips = store.add({
        message: 'Kumbara 3.1.0 (310) crashed: EXC_CRASH (SIGABRT)',
        kind: 'crash',
        level: 'fatal',
        origin: 'crash-report',
        ts: ts + 2000,
        data: { origin: 'crash-report', version: '3.1.0', build: '310', reportUrl: '/api/files/crash/u/Runner.ips', duplicateOf: live.id },
      });
      model.sync(store);
      // Regression: the record was hidden and no row had it (no crashed build, no .ips download).
      expect(model.count).toBe(1);
      const row = model.row(0)!;
      expect(row.e.source).toBe('app');
      expect(row.twin).toBe(true);
      expect(row.rec).toBe(ips);
    }
  });

  it('leaves a record visible when no row shows its live line', () => {
    const { store, model } = setup({ query: { test: (e) => e.origin === 'crash-report', matchesAll: false } });
    const live = store.add({ message: 'FATAL EXCEPTION: main', kind: 'crash', level: 'fatal', origin: 'logcat' });
    const rec = store.add({ message: 'x', kind: 'crash', level: 'fatal', origin: 'crash-report', data: { origin: 'crash-report', reportUrl: '/api/files/crash/u/a.ips', duplicateOf: live.id } });
    model.sync(store);
    expect(model.rows.slice(model.start).map((r) => r.e)).toEqual([rec]);
  });

  it('keeps the record with the download when a second one without it arrives', () => {
    const { store, model } = setup();
    const live = store.add({ message: 'FATAL EXCEPTION: main', kind: 'crash', level: 'fatal', origin: 'logcat' });
    const ips = store.add({ message: 'x', kind: 'crash', level: 'fatal', data: { origin: 'crash-report', reportUrl: '/api/files/crash/u/a.ips', duplicateOf: live.id } });
    store.add({ message: 'y', kind: 'crash', level: 'fatal', data: { origin: 'dropbox', duplicateOf: live.id } });
    model.sync(store);
    expect(model.row(0)!.rec).toBe(ips);
  });
});
