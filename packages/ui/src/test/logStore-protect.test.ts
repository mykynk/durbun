import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import { LogStore, PROTECTED_MAX, isProtectedEntry } from '../data/logStore';
import { compileScope, scopeLogCounts } from '../data/scope';
import { RowModel } from '../features/logs/model/rowModel';
import type { RowFilter } from '../features/logs/model/types';

/* A busy iPhone floods its log (~1000 lines/s of system daemons) while the Kumbara crash records sit in the ring. */
const IPHONE = 'ios:00008130-000A1B2C3D4E5F60';
let nextId = 1;
function line(p: Partial<LogEntry> = {}): LogEntry {
  return { id: nextId++, ts: 1_793_600_000_000, deviceId: IPHONE, source: 'device', origin: 'idevicesyslog', level: 'info', tag: 'spotlightknowledged', process: 'spotlightknowledged', message: '[Processing <private>]', ...p } as LogEntry;
}
const crashRecord = (p: Partial<LogEntry> = {}) =>
  line({ kind: 'crash', level: 'fatal', process: 'Runner', origin: 'crash-report', data: { origin: 'crash-report', bundleId: 'com.mykynk.kumbara', previousLaunch: true }, message: 'Kumbara 3.1.0 (310) crashed: EXC_BAD_ACCESS', ...p });
const flood = (n: number) => Array.from({ length: n }, () => line());
const ids = (s: LogStore) => [...s.kept, ...s.entries].map((e) => e.id);
const sorted = (s: LogStore) => ids(s).every((id, i, a) => i === 0 || a[i - 1]! < id);
const allLines = (): RowFilter => ({
  scope: () => true,
  minRank: 0,
  queryMinRank: 0,
  sources: { device: true, app: true, system: true },
  hideNoise: false,
  noise: () => false,
  showNetwork: true,
  query: { test: () => true, matchesAll: true },
  dedupe: false,
  fold: false,
});

describe('log ring: crash / ANR entries are evicted last', () => {
  it('what counts as protected', () => {
    expect(isProtectedEntry(line({ kind: 'crash' }))).toBe(true);
    expect(isProtectedEntry(line({ kind: 'anr' }))).toBe(true);
    expect(isProtectedEntry(line({ origin: 'dropbox' }))).toBe(true);
    expect(isProtectedEntry(line({ origin: 'crash-report' }))).toBe(true);
    expect(isProtectedEntry(line({ origin: undefined, data: { origin: 'dropbox' } }))).toBe(true); // older entries carry it in data
    expect(isProtectedEntry(line({ kind: 'flutter-error' }))).toBe(false);
    expect(isProtectedEntry(line({ level: 'fatal' }))).toBe(false);
  });

  it('a flood pushes out ordinary lines but keeps the crash records, their counts and the id order', () => {
    const s = new LogStore();
    s.maxEntries = 1_000;
    const ips = crashRecord();
    const anr = line({ kind: 'anr', level: 'error', origin: 'logcat', message: 'ANR in com.mykynk.kumbara' });
    s.append([line(), ips, line(), anr, ...flood(100)]);
    s.append(flood(5_000));
    // Regression: the plain ring dropped both records after 1 000 lines.
    expect(s.getById(ips.id)).toBe(ips);
    expect(s.getById(anr.id)).toBe(anr);
    expect(s.kept).toEqual([ips, anr]);
    expect(s.counts.crash).toBe(2);
    expect(s.countsByDevice.get(IPHONE)?.crash).toBe(2);
    expect(s.size).toBeLessThanOrEqual(1_000);
    expect(s.counts.total).toBe(s.size);
    expect(sorted(s)).toBe(true);
    expect(s.findLast((e) => e.kind === 'crash')).toBe(ips);
  });

  // Regression: a trim that kept a crash record rebuilt the array and bumped `generation`, so a scrolled-up
  // Logs view jumped back to live and the paused «N yeni satır» count jumped to the whole ring.
  it('a trim that keeps crash records is a plain head trim of `entries`: generation stays, the record stays findable', () => {
    const s = new LogStore();
    s.maxEntries = 1_000;
    const ips = crashRecord();
    s.append([ips, ...flood(999)]);
    const gen = s.generation;
    for (let i = 0; i < 20; i++) s.append(flood(150));
    expect(s.generation).toBe(gen);
    expect(s.entries[0]!.id).toBeGreaterThan(ips.id);
    expect(s.headDropped + s.entries.length).toBe(4_000); // the record left `entries` like any trimmed line
    expect(s.getById(ips.id)).toBe(ips);
    expect(s.counts.crash).toBe(1);
    expect(s.countsByDevice.get(IPHONE)).toMatchObject({ total: 1_000, crash: 1 });
  });

  it('a paused list counts only the new lines across a trim that keeps a crash record', () => {
    const s = new LogStore();
    s.maxEntries = 1_000;
    s.append([crashRecord(), ...flood(999)]);
    const model = new RowModel();
    model.setFilter(allLines());
    model.sync(s);
    const build = model.build;
    s.append(flood(50));
    expect(model.countPending(s)).toBe(50);
    s.append(flood(200));
    expect(model.countPending(s)).toBe(250); // was 950: the rebuild reset the pause cursor to the ring start
    model.sync(s);
    expect(model.build).toBe(build); // no rebuild → the view keeps its scroll position
    expect(model.count).toBe(s.entries.length);
  });

  it('without crash entries in the way the trim stays a plain head trim (no rebuild)', () => {
    const s = new LogStore();
    s.maxEntries = 100;
    s.append(flood(100));
    const gen = s.generation;
    s.append(flood(30));
    expect(s.size).toBe(100);
    expect(s.generation).toBe(gen);
    expect(s.headDropped).toBe(30);
    expect(s.kept).toHaveLength(0);
  });

  it('an out-of-order copy of a kept record replaces it; an older ordinary line is not taken in', () => {
    const s = new LogStore();
    s.maxEntries = 100;
    const ips = crashRecord();
    s.append([line(), ips, ...flood(200)]);
    expect(s.kept).toEqual([ips]);
    const copy = { ...ips, message: 'Kumbara 3.1.0 (310) crashed: EXC_BAD_ACCESS (symbolicated)' };
    s.append([copy, line({ id: 1 })]);
    expect(s.getById(ips.id)).toBe(copy);
    expect(s.counts.crash).toBe(1);
    expect(s.getById(1)).toBeUndefined();
    expect(s.counts.total).toBe(s.size);
    expect(sorted(s)).toBe(true);
  });

  it('clearing a device also clears its kept records', () => {
    const s = new LogStore();
    s.maxEntries = 100;
    s.append([crashRecord(), ...flood(200)]);
    expect(s.kept).toHaveLength(1);
    s.removeWhere((e) => e.deviceId === IPHONE);
    expect(s.kept).toHaveLength(0);
    expect(s.size).toBe(0);
    expect(s.counts).toMatchObject({ total: 0, crash: 0 });
  });

  it('keeps at most PROTECTED_MAX (and at most half the ring), the newest ones', () => {
    const big = new LogStore();
    big.maxEntries = 20_000;
    const crashes = Array.from({ length: PROTECTED_MAX + 50 }, () => crashRecord());
    big.append(crashes);
    big.append(flood(25_000));
    expect(big.counts.crash).toBe(PROTECTED_MAX);
    expect(big.getById(crashes[49]!.id)).toBeUndefined();
    expect(big.getById(crashes[50]!.id)).toBeDefined();
    const small = new LogStore();
    small.maxEntries = 100;
    small.append(Array.from({ length: 80 }, () => crashRecord()));
    small.append(flood(200));
    expect(small.counts.crash).toBe(50);
    expect(small.size).toBeLessThanOrEqual(100);
    expect(sorted(small)).toBe(true);
  });

  it('a device-app scope still counts its crash after the flood (scanned counters follow the rebuild)', () => {
    const s = new LogStore();
    s.maxEntries = 1_000;
    const hub = {
      apps: {},
      deviceApps: {
        [`${IPHONE}|com.mykynk.kumbara`]: {
          key: `${IPHONE}|com.mykynk.kumbara`,
          deviceId: IPHONE,
          id: 'com.mykynk.kumbara',
          name: 'Kumbara',
          buildType: 'release' as const,
          install: { source: 'store-or-testflight' as const },
          processName: 'Runner',
          pids: [3169],
          running: true,
          lastActivity: 1,
        },
      },
      processes: {},
    };
    const scope = compileScope({ kind: 'deviceApp', deviceId: IPHONE, bundleId: 'com.mykynk.kumbara' }, hub);
    s.append([crashRecord({ pid: 2841 }), line({ process: 'Runner', pid: 3169, message: 'sepet güncellendi' })]);
    expect(scopeLogCounts(scope, s)).toMatchObject({ total: 2, crash: 1 });
    s.append(flood(3_000));
    expect(scopeLogCounts(scope, s)).toMatchObject({ total: 1, crash: 1 });
    // A cache built after the move counts the kept record too.
    const fresh = compileScope({ kind: 'deviceApp', deviceId: IPHONE, bundleId: 'com.mykynk.kumbara' }, hub);
    expect(scopeLogCounts(fresh, s)).toMatchObject({ total: 1, crash: 1 });
    // Kept records over the cap leave the counters as they leave the store.
    s.maxEntries = 2;
    s.setMaxEntries(2);
    expect(s.kept).toHaveLength(1);
    s.append([crashRecord({ pid: 2841 }), crashRecord({ pid: 2841 }), ...flood(5)]);
    expect(s.kept).toHaveLength(1);
    expect(scopeLogCounts(scope, s)).toMatchObject({ total: 1, crash: 1 });
    expect(scopeLogCounts(fresh, s)).toMatchObject({ total: 1, crash: 1 });
  });
});
