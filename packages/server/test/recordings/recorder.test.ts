import { promises as fsp } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogEntry, ServerSettings } from '@durbun/protocol';
import { createHub } from '../../src/hub/index';
import { SessionRecorder, type RecorderOptions } from '../../src/recordings/recorder';
import {
  chunkName,
  decodeChunk,
  listRecordings,
  markInterrupted,
  readMeta,
  readRecording,
  RecordingWriter,
  RECORDING_FORMAT,
  sweepRecordings,
  type RecordingMeta,
} from '../../src/recordings/store';
import type { DeviceLogInput, Hub } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { makeTempDir } from '../http/fakes';
import { appInput, device, makeSettings } from '../hub/helpers';

const logcat = (message: string, level: LogEntry['level'] = 'info', patch: Partial<DeviceLogInput> = {}): DeviceLogInput => ({
  ts: Date.now(),
  level,
  tag: 'Pati',
  message,
  pid: 8421,
  tid: 8433,
  ...patch,
});

const tick = (ms = 160) => new Promise((r) => setTimeout(r, ms));
const BIG_LIMITS = { maxLogs: 1e6, maxRequests: 1e6, maxBodyBytes: 1e9 };

let dir: string;
let root: string;
let hubs: Hub[] = [];
let recorders: SessionRecorder[] = [];

beforeEach(async () => {
  dir = await makeTempDir('durbun-rec-');
  root = path.join(dir, 'recordings');
});
afterEach(async () => {
  for (const r of recorders) await r.stop().catch(() => {});
  for (const h of hubs) h.dispose();
  hubs = [];
  recorders = [];
  await fsp.rm(dir, { recursive: true, force: true });
});

function setup(settings: Partial<ServerSettings> = {}, opts: Partial<RecorderOptions> = {}) {
  let current = makeSettings(settings);
  const hub = createHub({ settings: current, logger: silentLogger });
  hubs.push(hub);
  const recorder = new SessionRecorder({
    root,
    hub,
    settings: () => current,
    logger: silentLogger,
    version: '9.9.9',
    flushIntervalMs: 60_000, // the tests flush by hand
    freeBytes: async () => 500 * 1024 ** 3,
    ...opts,
  });
  recorders.push(recorder);
  return {
    hub,
    recorder,
    setSettings: async (patch: Partial<ServerSettings>) => {
      current = { ...current, ...patch };
      await recorder.applySettings(current);
    },
  };
}

async function folders(): Promise<string[]> {
  return (await fsp.readdir(root).catch(() => [] as string[])).filter((n) => !n.startsWith('.'));
}

function captureSome(hub: Hub, n = 3): void {
  hub.upsertDevice(device('android:R5CT'));
  hub.pushDeviceLogs('android:R5CT', Array.from({ length: n }, (_, i) => logcat(`line ${i}`)));
}

describe('session recorder', () => {
  it('leaves nothing behind when the run captured nothing but its own lines', async () => {
    const { hub, recorder } = setup();
    await recorder.start();
    hub.addMarker('just a marker');
    hub.upsertDevice(device('android:R5CT', { logs: { status: 'stopped' } }));
    await tick();
    await recorder.flushNow();
    expect(recorder.status().state).toBe('waiting');
    await recorder.stop();
    expect(await folders()).toEqual([]);
  });

  it('writes what is captured and reads it back as a session file the import understands', async () => {
    const { hub, recorder } = setup();
    await recorder.start();
    captureSome(hub, 3);
    hub.pushDeviceLogs('android:R5CT', [logcat('FATAL EXCEPTION: main', 'fatal', { kind: 'crash' } as Partial<DeviceLogInput>)]);
    const app = hub.registerApp(appInput('android:R5CT'));
    hub.netRequest(app.id, { type: 'net.request', id: 'r1', ts: Date.now(), method: 'GET', url: 'https://api.pati.app/v1/pets', headers: [['authorization', 'Bearer x']], source: 'dart:io' });
    hub.netResponse(app.id, { type: 'net.response', id: 'r1', ts: Date.now() + 12, status: 200, headers: [['content-type', 'application/json']], body: { encoding: 'utf8', data: '{"ok":true}', size: 11 } });
    hub.pushAppMetrics(app.id, { ts: Date.now(), source: 'sdk', cpu: 12, memoryMB: 180 });
    await tick();
    await recorder.flushNow();
    expect(recorder.status().state).toBe('recording');
    const id = recorder.currentId!;
    await recorder.stop();

    const [rec] = await listRecordings(root);
    expect(rec).toMatchObject({ id, state: 'ended', counts: { logs: 4, requests: 1, errors: 1, crashes: 1 } });
    expect(rec!.devices).toEqual([{ id: 'android:R5CT', name: 'Pixel 8', platform: 'android' }]);
    expect(rec!.apps).toEqual([{ name: 'Pati', bundleId: 'com.mykynk.pati', deviceId: 'android:R5CT', version: '2.4.1' }]);
    expect(rec!.bytes).toBeGreaterThan(0);

    const read = await readRecording(root, id, BIG_LIMITS);
    expect(read.damaged).toBe(0);
    expect(read.data.format).toBe('durbun-session');
    expect(read.data.logs.filter((l) => l.source === 'device').map((l) => l.message)).toEqual(['line 0', 'line 1', 'line 2', 'FATAL EXCEPTION: main']);
    expect(read.data.network).toHaveLength(1);
    expect(read.data.network[0]).toMatchObject({ state: 'complete', status: 200, responseBody: { data: '{"ok":true}' } });
    expect(read.data.metrics?.length).toBe(1);
    expect(read.data.apps.map((a) => a.app.id)).toEqual(['com.mykynk.pati']);

    // The existing import path opens it (read-only import: devices).
    const other = createHub({ settings: makeSettings(), logger: silentLogger });
    hubs.push(other);
    const { deviceIds } = other.importSession(read.data, 'recording');
    expect(deviceIds).toHaveLength(1);
    expect(other.getNetwork()[0]!.deviceId).toBe(deviceIds[0]);
    expect(other.getLogs().some((l) => l.message === 'line 2')).toBe(true);
  });

  it('keeps files private: folders 0700, files 0600', async () => {
    const { hub, recorder } = setup();
    await recorder.start();
    captureSome(hub);
    await tick();
    await recorder.flushNow();
    const id = recorder.currentId!;
    await recorder.stop();
    expect((await fsp.stat(root)).mode & 0o777).toBe(0o700);
    expect((await fsp.stat(path.join(root, id))).mode & 0o777).toBe(0o700);
    for (const name of await fsp.readdir(path.join(root, id))) expect((await fsp.stat(path.join(root, id, name))).mode & 0o777).toBe(0o600);
  });

  it('does not record imported recordings or the demo', async () => {
    const { hub, recorder } = setup();
    await recorder.start();
    hub.upsertDevice(device('demo:1', { name: 'Demo' }));
    hub.pushDeviceLogs('demo:1', [logcat('demo line')]);
    hub.importSession({ format: 'durbun-session', version: 1, exportedAt: 1, server: { version: '1' }, devices: [], apps: [], logs: [{ id: 1, ts: 1, deviceId: 'x', source: 'device', level: 'info', message: 'imported line' } as LogEntry], network: [] }, 'file');
    await tick();
    await recorder.flushNow();
    expect(recorder.status().state).toBe('waiting');
    await recorder.stop();
    expect(await folders()).toEqual([]);
  });

  it('a hard kill leaves an interrupted recording whose torn end is skipped', async () => {
    const { hub, recorder } = setup();
    await recorder.start();
    captureSome(hub, 2);
    await tick();
    await recorder.flushNow();
    hub.pushDeviceLogs('android:R5CT', [logcat('second flush')]);
    await tick();
    await recorder.flushNow();
    const id = recorder.currentId!;
    // "Kill": nothing closes the recording, and the last write is cut in the middle.
    recorders = recorders.filter((r) => r !== recorder);
    const file = path.join(root, id, chunkName(1));
    const buf = await fsp.readFile(file);
    await fsp.writeFile(file, buf.subarray(0, buf.length - 40));

    const next = setup();
    await next.recorder.start();
    const list = await next.recorder.list();
    expect(list.recordings[0]).toMatchObject({ id, state: 'interrupted' });
    expect(list.previous).toBe(id);
    expect((await readMeta(path.join(root, id)))?.interrupted).toBe(true);
    const read = await readRecording(root, id, BIG_LIMITS);
    expect(read.damaged).toBeGreaterThan(0);
    expect(read.data.logs.filter((l) => l.source === 'device').map((l) => l.message)).toEqual(['line 0', 'line 1']);
  });

  it('pauses on a full disk, says so once, keeps the live data and goes on later', async () => {
    let fail = true;
    const { hub, recorder } = setup(
      {},
      {
        retryMs: 1,
        openChunk: async (file) => {
          const real = await fsp.open(file, 'a', 0o600);
          return {
            write: async (data: Buffer) => {
              if (fail) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
              return real.write(data);
            },
            datasync: () => real.datasync(),
            close: () => real.close(),
          };
        },
      },
    );
    await recorder.start();
    captureSome(hub, 5);
    await tick();
    await recorder.flushNow();
    expect(recorder.status()).toMatchObject({ state: 'paused', paused: { code: 'recorder.diskFull' } });
    hub.pushDeviceLogs('android:R5CT', [logcat('still live')]);
    await tick();
    await recorder.flushNow(); // fails again: the same episode, no second line
    const lines = hub.getLogs().filter((l) => l.code === 'recorder.diskFull');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.params).toEqual({ dir: root });
    expect(hub.getLogs().some((l) => l.message === 'still live')).toBe(true);

    fail = false;
    await tick(5);
    hub.pushDeviceLogs('android:R5CT', [logcat('after the disk')]);
    await tick();
    await recorder.flushNow();
    expect(recorder.status().state).toBe('recording');
    expect(hub.getLogs().filter((l) => l.code === 'recorder.resumed')).toHaveLength(1);
    const id = recorder.currentId!;
    await recorder.stop();
    const meta = await readMeta(path.join(root, id));
    expect(meta?.gaps).toBeGreaterThan(0);
    const read = await readRecording(root, id, BIG_LIMITS);
    expect(read.data.logs.some((l) => l.message === 'after the disk')).toBe(true);
  });

  it('pauses when it cannot write to the folder (EACCES)', async () => {
    await fsp.mkdir(root, { mode: 0o500 });
    const { hub, recorder } = setup();
    await recorder.start();
    captureSome(hub);
    await tick();
    await recorder.flushNow();
    expect(recorder.status()).toMatchObject({ state: 'paused', paused: { code: 'recorder.noAccess', params: { dir: root } } });
    expect(hub.getLogs().filter((l) => l.code === 'recorder.noAccess')).toHaveLength(1);
    await recorder.stop();
    await fsp.chmod(root, 0o700);
  });

  it('pauses on low disk space before the disk is full', async () => {
    let free = 200 * 1024 ** 2;
    const { hub, recorder } = setup({}, { freeBytes: async () => free });
    await recorder.start();
    captureSome(hub);
    await tick();
    await recorder.flushNow();
    expect(recorder.status()).toMatchObject({ state: 'paused', paused: { code: 'recorder.diskLow' } });
    expect(await folders()).toEqual([]);
    free = 400 * 1024 ** 3;
    expect(recorder.status().state).toBe('paused'); // checked again on a later write (every 30 s)
    await recorder.stop();
  });

  it('a capture faster than the disk pauses as "too slow" with a bounded queue, then goes on', async () => {
    const { hub, recorder } = setup({}, { maxPendingRecords: 20 });
    await recorder.start();
    hub.upsertDevice(device('android:R5CT'));
    hub.pushDeviceLogs('android:R5CT', Array.from({ length: 100 }, (_, i) => logcat(`burst ${i}`)));
    await tick();
    expect(recorder.status()).toMatchObject({ state: 'paused', paused: { code: 'recorder.tooSlow' } });
    expect(hub.getLogs().filter((l) => l.message.startsWith('burst'))).toHaveLength(100); // live data untouched
    await recorder.flushNow();
    expect(recorder.status().state).toBe('recording');
    const id = recorder.currentId!;
    await recorder.stop();
    expect((await readMeta(path.join(root, id)))?.gaps).toBeGreaterThan(0);
  });

  it('turning it off closes the recording at once; on again starts a new one', async () => {
    const { hub, recorder, setSettings } = setup();
    await recorder.start();
    captureSome(hub);
    await tick();
    await recorder.flushNow();
    const first = recorder.currentId!;
    await setSettings({ recordSessions: false });
    expect(recorder.status()).toMatchObject({ enabled: false, state: 'off' });
    expect(recorder.currentId).toBeUndefined();
    expect((await readMeta(path.join(root, first)))?.endedAt).toBeTypeOf('number');
    hub.pushDeviceLogs('android:R5CT', [logcat('while off')]);
    await tick();
    await recorder.flushNow();
    expect(await folders()).toEqual([first]);

    await setSettings({ recordSessions: true });
    hub.pushDeviceLogs('android:R5CT', [logcat('on again')]);
    await tick();
    await recorder.flushNow();
    expect(recorder.currentId).toBeDefined();
    expect(recorder.currentId).not.toBe(first);
    const read = await readRecording(root, first, BIG_LIMITS);
    expect(read.data.logs.some((l) => l.message === 'while off')).toBe(false);
  });

  it('never deletes the recording being written; delete all keeps it', async () => {
    const { hub, recorder } = setup();
    await recorder.start();
    captureSome(hub);
    await tick();
    await recorder.flushNow();
    const live = recorder.currentId!;
    expect(await recorder.delete(live)).toBe(false);
    expect(await recorder.deleteAll()).toEqual([]);
    const removed = await sweepRecordings(root, { maxDays: 0, maxBytes: 0, maxRecordingBytes: 0 }, new Set([live]), Date.now() + 10 * 86_400_000);
    expect(removed).toEqual([]);
    expect(await folders()).toEqual([live]);
  });
});

/* ────────────────────────────── store ────────────────────────────── */

function meta(id: string, patch: Partial<RecordingMeta> = {}): RecordingMeta {
  return {
    format: RECORDING_FORMAT,
    version: 1,
    id,
    startedAt: 1_000,
    lastWriteAt: 2_000,
    endedAt: 2_000,
    counts: { logs: 0, requests: 0, errors: 0, crashes: 0 },
    devices: [],
    apps: [],
    ...patch,
  };
}

const logLine = (id: number, message = `m${id}`) =>
  JSON.stringify({ k: 'log', v: { id, ts: id, deviceId: 'android:A', source: 'device', level: 'info', message } }) + '\n';

describe('recording store', () => {
  it('rotates chunks and, past the per-recording limit, removes whole old chunks (each chunk reads on its own)', async () => {
    const w = new RecordingWriter({
      root,
      meta: meta('20261115T184012Z-a1b2', { endedAt: undefined }),
      header: () => [{ k: 'device', v: device('android:A', { name: 'Galaxy' }) }],
      maxRecordingBytes: 2_000,
      chunkBytes: 400,
    });
    for (let i = 1; i <= 120; i++) {
      // Random text compresses badly, so chunks fill up.
      await w.append(logLine(i, `${i} ${Math.random().toString(36)}${Math.random().toString(36)}`));
    }
    await w.close(3_000);
    const files = (await fsp.readdir(w.dir)).filter((f) => f.startsWith('chunk-'));
    expect(files.length).toBeGreaterThan(1);
    expect(files).not.toContain(chunkName(1));
    expect(w.meta.trimmed).toBe(true);
    const read = await readRecording(root, w.meta.id, BIG_LIMITS);
    expect(read.data.devices.map((d) => d.name)).toEqual(['Galaxy']);
    const ids = read.data.logs.map((l) => l.id);
    expect(ids.at(-1)).toBe(120);
    expect(ids[0]).toBeGreaterThan(1);
    expect(read.left.logs).toBe(0); // only what is on disk counts; the trim is said by `trimmed`
  });

  it('a corrupt member in the middle loses only its own lines', async () => {
    const id = '20261115T184012Z-c0de';
    const w = new RecordingWriter({ root, meta: meta(id), header: () => [], maxRecordingBytes: 1e9 });
    await w.append(logLine(1));
    await w.append(logLine(2));
    await w.append(logLine(3));
    await w.close(5_000);
    const file = path.join(w.dir, chunkName(1));
    const buf = await fsp.readFile(file);
    const members = decodeChunk(buf);
    expect(members.lines).toHaveLength(3);
    // Flip a byte inside the second member's deflate data.
    const second = buf.indexOf(zlib.gzipSync(Buffer.alloc(0)).subarray(0, 10), 10);
    buf[second + 14] = buf[second + 14]! ^ 0xff;
    await fsp.writeFile(file, buf);
    const read = await readRecording(root, id, BIG_LIMITS);
    expect(read.data.logs.map((l) => l.id)).toEqual([1, 3]);
    expect(read.damaged).toBe(1);
  });

  it('reads the newest part within the limits and counts what it left', async () => {
    const id = '20261115T184012Z-0001';
    const w = new RecordingWriter({ root, meta: meta(id, { counts: { logs: 50, requests: 0, errors: 0, crashes: 0 } }), header: () => [], maxRecordingBytes: 1e9 });
    let text = '';
    for (let i = 1; i <= 50; i++) text += logLine(i);
    await w.append(text);
    await w.close(5_000);
    const read = await readRecording(root, id, { maxLogs: 10, maxRequests: 10, maxBodyBytes: 0 });
    expect(read.data.logs.map((l) => l.id)).toEqual([41, 42, 43, 44, 45, 46, 47, 48, 49, 50]);
    expect(read.loaded.logs).toBe(10);
    expect(read.left.logs).toBe(40);
  });

  it('keeps the newest state of a request and drops bodies past the body budget (oldest first)', async () => {
    const id = '20261115T184012Z-0002';
    const w = new RecordingWriter({ root, meta: meta(id), header: () => [], maxRecordingBytes: 1e9 });
    const net = (rid: string, state: string, body: string) =>
      JSON.stringify({ k: 'net', v: { id: rid, deviceId: 'android:A', source: 'okhttp', method: 'GET', url: 'https://x.test/', host: 'x.test', path: '/', startTs: 1, state, requestHeaders: [], hasRequestBody: false, hasResponseBody: true, responseBody: { encoding: 'utf8', data: body, size: body.length } } }) + '\n';
    await w.append(net('a', 'pending', 'x'.repeat(10)) + net('b', 'complete', 'y'.repeat(10)) + net('a', 'complete', 'z'.repeat(10)));
    await w.close(5_000);
    const read = await readRecording(root, id, { maxLogs: 10, maxRequests: 10, maxBodyBytes: 15 });
    expect(read.data.network.map((n) => [n.id, n.state, n.responseBody?.data ?? null, n.bodyEvicted ?? false])).toEqual([
      ['b', 'complete', null, true],
      ['a', 'complete', 'zzzzzzzzzz', false],
    ]);
  });

  it('sweeps by age, then by size (oldest first), never what it is told to keep; marks unclosed ones interrupted', async () => {
    const day = 86_400_000;
    const now = 100 * day;
    const make = async (id: string, lastWriteAt: number, bytes: number, ended = true) => {
      const w = new RecordingWriter({ root, meta: meta(id, { startedAt: lastWriteAt - 1000, lastWriteAt, endedAt: ended ? lastWriteAt : undefined }), header: () => [], maxRecordingBytes: 1e12 });
      await w.writeMeta();
      await fsp.writeFile(path.join(w.dir, chunkName(1)), Buffer.alloc(bytes), { mode: 0o600 });
    };
    await make('20260101T000000Z-0001', now - 9 * day, 1_000); // too old
    await make('20260101T000000Z-0002', now - 3 * day, 6_000);
    await make('20260101T000000Z-0003', now - 2 * day, 6_000);
    await make('20260101T000000Z-0004', now - 20 * day, 6_000, false); // old, but kept (live)
    await make('20260101T000000Z-0005', now - 1 * day, 3_000, false);
    expect(await markInterrupted(root, '20260101T000000Z-0004')).toEqual(['20260101T000000Z-0005']);
    const removed = await sweepRecordings(root, { maxDays: 7, maxBytes: 18_000, maxRecordingBytes: 1e9 }, new Set(['20260101T000000Z-0004']), now);
    expect(removed).toEqual(['20260101T000000Z-0001', '20260101T000000Z-0002']);
    const left = await listRecordings(root, '20260101T000000Z-0004');
    expect(left.map((r) => [r.id, r.state])).toEqual([
      ['20260101T000000Z-0005', 'interrupted'],
      ['20260101T000000Z-0003', 'ended'],
      ['20260101T000000Z-0004', 'recording'],
    ]);
  });
});
