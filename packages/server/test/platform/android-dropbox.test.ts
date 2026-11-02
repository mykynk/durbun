import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import type { Adb } from '../../src/platform/android/adb';
import type { DeviceClock } from '../../src/platform/android/deviceClock';
import {
  CrashIndex,
  createDropboxCursor,
  DROPBOX_SEP,
  DROPBOX_TAGS,
  DROPBOX_TIMING,
  dropboxKey,
  dropboxToCrash,
  DropboxWatcher,
  parseDropboxListing,
  parseDropboxPrint,
  type DropboxApps,
  type DropboxCursor,
} from '../../src/platform/android/dropbox';
import type { CrashAppMeta } from '../../src/platform/android/deviceApps';
import type { RunResult } from '../../src/platform/exec';
import { silentLogger } from '../../src/util/logger';
import { createFakeHub } from './helpers';

const fx = (name: string): string => fs.readFileSync(new URL(`./android-fixtures/${name}`, import.meta.url), 'utf8');
const IST: DeviceClock = { tzName: 'Europe/Istanbul', offsetMinutes: 180 };
/** 2026-11-02 12:00:00 in Istanbul. */
const NOW = Date.UTC(2026, 10, 2, 9, 0, 0);
const DEVICE = 'android:R58M123ABC';
const ist = (y: number, mo: number, d: number, h: number, mi: number, s: number, ms = 0) => Date.UTC(y, mo - 1, d, h - 3, mi, s, ms);

function record(file: string, date?: string) {
  const recs = parseDropboxPrint(fx(file));
  return date ? recs.find((r) => r.date === date)! : recs[0]!;
}

describe('dumpsys dropbox parsing', () => {
  it('lists headers of the four tags, counting records that share a second', () => {
    const hs = parseDropboxListing(fx('dropbox-list.txt'));
    expect(hs.map((h) => `${h.tag} ${h.date} #${h.index} ${h.text ? 'text' : '-'}`)).toEqual([
      'data_app_crash 2026-10-31 09:12:00 #0 text',
      'data_app_crash 2026-11-01 18:02:44 #0 text',
      'data_app_crash 2026-11-02 11:43:03 #0 text',
      'data_app_anr 2026-11-02 11:44:58 #0 text',
      'data_app_native_crash 2026-11-02 11:43:10 #0 text',
      'SYSTEM_TOMBSTONE 2026-11-02 10:15:20 #0 text',
      'SYSTEM_TOMBSTONE 2026-11-02 11:43:11 #0 text',
      'SYSTEM_TOMBSTONE 2026-11-02 11:43:11 #1 -',
    ]);
    expect(hs[3]!.bytes).toBe(61442);
  });

  it('splits --print output into records with headers and body', () => {
    const recs = parseDropboxPrint(fx('dropbox-print-data_app_crash.txt'));
    expect(recs).toHaveLength(2);
    const r = recs[1]!;
    expect(r).toMatchObject({ tag: 'data_app_crash', date: '2026-11-02 11:43:03', index: 0, bytes: 1874 });
    expect(r.headers).toMatchObject({ Process: 'com.mykynk.pati', PID: '4321', Flags: '0x38c8be46', Foreground: 'Yes' });
    expect(r.packages).toEqual(['com.mykynk.pati v1 (1.4.0-dev)']);
    expect(r.body.split('\n')[0]).toBe('java.lang.IllegalStateException: Boom');
    expect(r.body.endsWith('ActivityThread.java:8177)')).toBe(true);
    // Same second twice → index 0 and 1; binary / lost entries are skipped.
    const two = parseDropboxPrint(
      [
        '========================================',
        '2026-11-02 11:00:00 data_app_crash (text, 10 bytes)',
        'Process: com.a.b\n\njava.lang.Error: one\n',
        '========================================',
        '2026-11-02 11:00:00 data_app_crash (text, 10 bytes)',
        'Process: com.a.b\n\njava.lang.Error: two\n',
        '========================================',
        '2026-11-02 11:00:01 SYSTEM_TOMBSTONE_PROTO (compressed data, 4021 bytes)',
        '/data/system/dropbox/SYSTEM_TOMBSTONE_PROTO@1793608801000.dat.gz',
      ].join('\n'),
    );
    expect(two.map((r) => [r.index, r.body])).toEqual([
      [0, 'java.lang.Error: one'],
      [1, 'java.lang.Error: two'],
    ]);
  });

  it('data_app_crash → crash entry with the Java throwable (previous launch keeps the pid in data only)', () => {
    const c = dropboxToCrash(record('dropbox-print-data_app_crash.txt', '2026-11-01 18:02:44'), IST, NOW - 60_000)!;
    expect(c).toMatchObject({ kind: 'crash', pkg: 'com.mykynk.pati', process: 'com.mykynk.pati', pid: 30121 });
    expect(c.ts).toBe(ist(2026, 11, 1, 18, 2, 44));
    expect(c.entry).toMatchObject({
      ts: c.ts,
      level: 'fatal',
      kind: 'crash',
      origin: 'dropbox',
      tag: 'data_app_crash',
      process: 'com.mykynk.pati',
      error: {
        type: 'java.lang.RuntimeException',
        message:
          'Unable to start activity ComponentInfo{com.mykynk.pati/com.mykynk.pati.MainActivity}: java.lang.IllegalStateException: Boom',
      },
      data: {
        origin: 'dropbox',
        package: 'com.mykynk.pati',
        process: 'com.mykynk.pati',
        pid: 30121,
        reportTs: c.ts,
        previousLaunch: true,
        version: '1.3.2',
        build: '41',
        debuggable: false,
        foreground: true,
      },
    });
    expect(c.entry.pid).toBeUndefined();
    expect(c.entry.error!.stack).toContain('Caused by: java.lang.IllegalStateException: Boom');
    expect(c.entry.message.startsWith('java.lang.RuntimeException: Unable to start activity')).toBe(true);
    expect(c.meta).toEqual({ reportTs: c.ts, version: '1.3.2', build: '41', debuggable: false });
    // Recorded after Dürbün started watching → live record with the pid.
    const live = dropboxToCrash(record('dropbox-print-data_app_crash.txt', '2026-11-02 11:43:03'), IST, ist(2026, 11, 2, 11, 40, 0))!;
    expect(live.entry.pid).toBe(4321);
    expect(live.entry.data).toMatchObject({ previousLaunch: false, debuggable: true, version: '1.4.0-dev', build: '1' });
  });

  it('data_app_anr → anr entry, subject as message, main thread as stack', () => {
    const c = dropboxToCrash(record('dropbox-print-data_app_anr.txt'), IST, NOW)!;
    expect(c.kind).toBe('anr');
    expect(c.entry.level).toBe('error');
    expect(c.entry.message).toBe(
      'Input dispatching timed out (ActivityRecord{a1b2c3 u0 com.mykynk.pati/.MainActivity t42} is not responding. Waited 5001ms for FocusEvent(hasFocus=true))',
    );
    expect(c.entry.error).toMatchObject({ type: 'ANR', message: c.entry.message });
    expect(c.entry.error!.stack!.split('\n')[0]).toBe('"main" prio=5 tid=1 Runnable');
    expect(c.entry.error!.stack).toContain('PaymentRepository.computeHash(PaymentRepository.kt:88)');
    expect(c.entry.error!.stack).not.toContain('Signal Catcher');
    expect(c.entry.data).toMatchObject({ package: 'com.mykynk.pati', pid: 4400, previousLaunch: true });
  });

  it('data_app_native_crash / SYSTEM_TOMBSTONE → signal, cause, abort message and backtrace', () => {
    const n = dropboxToCrash(record('dropbox-print-data_app_native_crash.txt'), IST, NOW)!;
    expect(n).toMatchObject({ kind: 'crash', pkg: 'com.example.native', pid: 5001 });
    expect(n.entry.message.split('\n')[0]).toBe('signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0000000000000000');
    expect(n.entry.message).toContain('Cause: null pointer dereference');
    expect(n.entry.message).toContain('#00 pc 000000000004ee8c');
    expect(n.entry.error).toMatchObject({ type: 'SIGSEGV', message: 'null pointer dereference' });
    expect(n.entry.error!.stack!.split('\n')).toHaveLength(3);
    expect(n.entry.data).toMatchObject({ signal: 'SIGSEGV', thread: 'RenderThread', version: '2.0.26', build: '20026', debuggable: false });

    const t = parseDropboxPrint(fx('dropbox-print-SYSTEM_TOMBSTONE.txt'));
    const app = dropboxToCrash(t[1]!, IST, NOW)!;
    expect(app).toMatchObject({ tag: 'SYSTEM_TOMBSTONE', pkg: 'com.example.native', process: 'com.example.native', pid: 5001 });
    expect(app.entry.data).toMatchObject({ signal: 'SIGSEGV', package: 'com.example.native' });
    const daemon = dropboxToCrash(t[0]!, IST, NOW)!;
    expect(daemon.pkg).toBeUndefined();
    expect(daemon.process).toBe('/vendor/bin/hw/android.hardware.camera.provider@2.7-service-google');
    expect(daemon.entry.error).toMatchObject({ type: 'SIGABRT', message: 'Check failed: stream != nullptr' });
    expect(daemon.entry.data).toMatchObject({ abortMessage: 'Check failed: stream != nullptr' });
  });
});

describe('CrashIndex de-duplication', () => {
  const logcatCrash: LogEntry = {
    id: 77,
    ts: ist(2026, 11, 2, 11, 43, 2, 640),
    deviceId: DEVICE,
    source: 'device',
    origin: 'logcat',
    level: 'fatal',
    kind: 'crash',
    tag: 'AndroidRuntime',
    message: 'FATAL EXCEPTION: main\nProcess: com.mykynk.pati, PID: 4321\njava.lang.IllegalStateException: Boom',
    pid: 4321,
    process: 'com.mykynk.pati',
    data: { crashedProcess: 'com.mykynk.pati', crashedPid: 4321 },
  };

  it('matches by pid (≤ 30 s) or package (± 5 s) and kind; ignores other devices', () => {
    const idx = new CrashIndex(DEVICE);
    idx.add(logcatCrash);
    idx.add({ ...logcatCrash, id: 78, deviceId: 'android:OTHER' });
    idx.add({ ...logcatCrash, id: 79, kind: undefined });
    expect(idx.size).toBe(1);
    const base = { kind: 'crash' as const, tag: 'data_app_crash', ts: ist(2026, 11, 2, 11, 43, 3) };
    expect(idx.findDuplicate({ ...base, pid: 4321, pkg: 'com.mykynk.pati' })).toEqual({ id: 77, origin: 'logcat' });
    expect(idx.findDuplicate({ ...base, pkg: 'com.mykynk.pati' })).toEqual({ id: 77, origin: 'logcat' });
    expect(idx.findDuplicate({ ...base, pid: 4321, ts: base.ts + 20_000 })?.id).toBe(77);
    expect(idx.findDuplicate({ ...base, pkg: 'com.mykynk.pati', ts: base.ts + 20_000 })).toBeUndefined();
    expect(idx.findDuplicate({ ...base, kind: 'anr', pid: 4321, pkg: 'com.mykynk.pati' })).toBeUndefined();
    expect(idx.findDuplicate({ ...base, pid: 999, pkg: 'com.other.app' })).toBeUndefined();
  });

  it('prefers the fatal Java crash over a same-pid Dart "Unhandled Exception" line; links native_crash ↔ tombstone', () => {
    const idx = new CrashIndex(DEVICE);
    idx.add({ ...logcatCrash, id: 10, level: 'error', tag: 'flutter', ts: logcatCrash.ts - 100 });
    idx.add(logcatCrash);
    expect(idx.findDuplicate({ kind: 'crash', tag: 'data_app_crash', ts: ist(2026, 11, 2, 11, 43, 3), pid: 4321 })?.id).toBe(77);
    idx.add({
      id: 90,
      ts: ist(2026, 11, 2, 11, 43, 10),
      deviceId: DEVICE,
      source: 'device',
      origin: 'dropbox',
      level: 'fatal',
      kind: 'crash',
      tag: 'data_app_native_crash',
      message: 'signal 11',
      data: { origin: 'dropbox', dropboxTag: 'data_app_native_crash', pid: 5001, package: 'com.example.native' },
    });
    const tomb = { kind: 'crash' as const, ts: ist(2026, 11, 2, 11, 43, 11), pid: 5001, pkg: 'com.example.native' };
    expect(idx.findDuplicate({ ...tomb, tag: 'SYSTEM_TOMBSTONE' })).toEqual({ id: 90, origin: 'dropbox' });
    expect(idx.findDuplicate({ ...tomb, tag: 'data_app_native_crash' })).toBeUndefined();
  });
});

/* ───────────── watcher ───────────── */

function ok(stdout: string): RunResult<string> {
  return { ok: true, code: 0, signal: null, stdout, stderr: '', timedOut: false };
}

const LIST_CMD = DROPBOX_TAGS.map((t) => `dumpsys dropbox ${t}`).join(`; echo ${DROPBOX_SEP}; `);

function setup(opts: { listing?: string; cursor?: DropboxCursor; watchStart?: number } = {}) {
  const calls: string[] = [];
  const adb = {
    path: '/fake/adb',
    tool: { path: '/fake/adb', source: 'path' },
    async shell(_serial: string, cmd: string) {
      calls.push(cmd);
      if (cmd === LIST_CMD) return ok(opts.listing ?? fx('dropbox-list.txt'));
      const m = /^dumpsys dropbox --print (\S+)/.exec(cmd);
      if (m) return ok(fx(`dropbox-print-${m[1]}.txt`));
      return ok('');
    },
  } as unknown as Adb;
  const hub = createFakeHub();
  const crashes = new CrashIndex(DEVICE);
  let nextId = 1000;
  const pushed: LogEntry[] = [];
  const push = hub.pushDeviceLogs;
  // Like the real hub: assign ids and run the synchronous onLogs tap.
  hub.pushDeviceLogs = (deviceId, entries) => {
    push(deviceId, entries);
    for (const e of entries) {
      const full = { ...e, id: nextId++, deviceId, source: 'device' } as LogEntry;
      pushed.push(full);
      crashes.add(full);
    }
  };
  const noted: Array<{ pkg: string; meta: CrashAppMeta }> = [];
  const third = new Set(['com.mykynk.pati', 'com.example.native', 'com.whatsapp']);
  const apps: DropboxApps = {
    ready: async () => true,
    isThirdParty: (p) => third.has(p),
    isSystem: (p) => p === 'com.google.android.gms',
    noteCrash: (pkg, meta) => noted.push({ pkg, meta }),
  };
  const cursor = opts.cursor ?? createDropboxCursor();
  const watcher = new DropboxWatcher({
    adb: () => adb,
    serial: 'R58M123ABC',
    deviceId: DEVICE,
    hub,
    logger: silentLogger,
    cursor,
    clock: IST,
    watchStart: () => opts.watchStart ?? NOW - 60_000,
    apps,
    crashes,
  });
  return { watcher, calls, pushed, noted, crashes, cursor };
}

describe('DropboxWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the last 24 h once, third-party only, de-duplicated, then only new records', async () => {
    const t = setup();
    // The live logcat crash of 11:43:02.640 (already in the hub).
    t.crashes.add({
      id: 77,
      ts: ist(2026, 11, 2, 11, 43, 2, 640),
      deviceId: DEVICE,
      source: 'device',
      origin: 'logcat',
      level: 'fatal',
      kind: 'crash',
      tag: 'AndroidRuntime',
      message: 'FATAL EXCEPTION: main',
      pid: 4321,
      process: 'com.mykynk.pati',
    });
    await t.watcher.pollNow();
    expect(t.calls[0]).toBe(LIST_CMD);
    // Prints are filtered to the exact second of each new record; the 2-day-old WhatsApp crash is not read.
    expect(t.calls.slice(1)).toEqual([
      `dumpsys dropbox --print data_app_crash 2026-11-01 18:02:44; echo ${DROPBOX_SEP}; dumpsys dropbox --print data_app_crash 2026-11-02 11:43:03`,
      'dumpsys dropbox --print data_app_anr 2026-11-02 11:44:58',
      'dumpsys dropbox --print data_app_native_crash 2026-11-02 11:43:10',
      `dumpsys dropbox --print SYSTEM_TOMBSTONE 2026-11-02 10:15:20; echo ${DROPBOX_SEP}; dumpsys dropbox --print SYSTEM_TOMBSTONE 2026-11-02 11:43:11`,
    ]);
    const rows = t.pushed.map((e) => [e.tag, (e.data as { package?: string }).package, (e.data as { duplicateOf?: number }).duplicateOf]);
    expect(rows).toEqual([
      ['data_app_crash', 'com.mykynk.pati', undefined], // yesterday (previous launch)
      ['data_app_crash', 'com.mykynk.pati', 77], // = the live logcat crash
      ['data_app_native_crash', 'com.example.native', undefined],
      ['SYSTEM_TOMBSTONE', 'com.example.native', 1002], // = the data_app_native_crash record
      ['data_app_anr', 'com.mykynk.pati', undefined],
    ]);
    expect(t.pushed.every((e) => e.origin === 'dropbox' && (e.data as { previousLaunch: boolean }).previousLaunch)).toBe(true);
    // The camera HAL tombstone (system daemon) is not shown; the tombstone duplicate is not counted twice.
    expect(t.noted.map((n) => n.pkg)).toEqual(['com.mykynk.pati', 'com.mykynk.pati', 'com.example.native', 'com.mykynk.pati']);
    expect(t.noted[0]!.meta).toMatchObject({ version: '1.3.2', build: '41', debuggable: false });

    // Nothing new → one cheap listing call, no prints.
    const before = t.calls.length;
    await t.watcher.pollNow();
    expect(t.calls.slice(before)).toEqual([LIST_CMD]);
    expect(t.pushed).toHaveLength(5);
    expect(t.watcher.polls).toBe(2);
  });

  it('a replugged device (same cursor) does not repeat records; a new record is read alone', async () => {
    const first = setup();
    await first.watcher.pollNow();
    expect(first.pushed).toHaveLength(5);
    const listing = fx('dropbox-list.txt').replace(
      '2026-11-02 11:43:03 data_app_crash (text, 1874 bytes)',
      '2026-11-02 11:43:03 data_app_crash (text, 1874 bytes)\n2026-11-02 11:58:30 data_app_crash (text, 1201 bytes)',
    );
    const again = setup({ cursor: first.cursor, listing });
    await again.watcher.pollNow();
    expect(again.calls.slice(1)).toEqual(['dumpsys dropbox --print data_app_crash 2026-11-02 11:58:30']);
    // (The fixture has no record at 11:58:30 → nothing pushed, but it is not asked for again.)
    expect(again.pushed).toHaveLength(0);
    await again.watcher.pollNow();
    expect(again.calls.filter((c) => c.includes('--print'))).toHaveLength(1);
    expect(again.cursor.seen.has(dropboxKey({ tag: 'data_app_crash', date: '2026-11-02 11:58:30', index: 0 }))).toBe(true);
  });

  it('reports an unreadable dropbox as data, without throwing', async () => {
    const t = setup({ listing: "Permission Denial: can't dump DropBoxManagerService from from pid=12345, uid=2000 due to missing android.permission.DUMP permission\n" });
    await t.watcher.pollNow();
    expect(t.watcher.unavailable).toMatch(/Permission Denial/);
    expect(t.pushed).toHaveLength(0);
    expect(t.calls).toHaveLength(1);
  });

  it('waits briefly before matching a fresh record so the live logcat crash can land first', async () => {
    vi.setSystemTime(ist(2026, 11, 2, 11, 43, 20));
    const saved = DROPBOX_TIMING.settleMs;
    DROPBOX_TIMING.settleMs = 30;
    try {
      const t = setup({ listing: fx('dropbox-list.txt').split(DROPBOX_SEP)[0], watchStart: ist(2026, 11, 2, 11, 40, 0) });
      const poll = t.watcher.pollNow();
      // The grouped FATAL EXCEPTION arrives while the watcher is settling.
      setTimeout(() => {
        t.crashes.add({
          id: 501,
          ts: ist(2026, 11, 2, 11, 43, 2, 900),
          deviceId: DEVICE,
          source: 'device',
          origin: 'logcat',
          level: 'fatal',
          kind: 'crash',
          tag: 'AndroidRuntime',
          message: 'FATAL EXCEPTION: main',
          pid: 4321,
        });
      }, 5);
      await poll;
      const live = t.pushed.find((e) => e.ts === ist(2026, 11, 2, 11, 43, 3))!;
      expect(live.pid).toBe(4321);
      expect(live.data).toMatchObject({ duplicateOf: 501, previousLaunch: false });
    } finally {
      DROPBOX_TIMING.settleMs = saved;
    }
  });
});
