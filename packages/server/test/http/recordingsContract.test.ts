/**
 * The UI's dev mock (`packages/ui/dev/mock-recordings.mjs`, served by `mock-server.mjs`) must answer /api/recordings
 * like the real server: the same shapes (SessionRecordingList / SessionRecording / RecorderStatus /
 * SessionRecordingOpen), the same status codes and error codes, the same methods. A mock that drifts hides a broken
 * recordings dialog until the real app runs. The real server runs in process on a temp data dir.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type SessionRecordingList } from '@durbun/protocol';
import { createHub } from '../../src/hub/index';
import type { Hub } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { connectUi, startTestApp, type TestApp } from './fakes';
import { device } from '../hub/helpers';

type MockRecordings = { handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, query: URLSearchParams): boolean };
type MockModule = { createMockRecordings(opts?: object): MockRecordings };

let real: TestApp;
let hub: Hub;
let mock: http.Server;
let mockBase = '';
let realClosed = '';
let mockClosed = '';
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  hub = createHub({ settings: { ...DEFAULT_SETTINGS }, logger: silentLogger });
  real = await startTestApp({ hub, recordings: { flushIntervalMs: 50, freeBytes: async () => 500 * 1024 ** 3 } });
  // One closed recording on the real server, then a new run being written.
  hub.upsertDevice(device('android:R5CT'));
  hub.pushDeviceLogs('android:R5CT', [{ ts: Date.now(), level: 'info', tag: 't', message: 'hello' }]);
  await tick(250);
  const ui = await connectUi(real.port);
  await ui.synced();
  await ui.command({ name: 'settings.update', patch: { recordSessions: false } });
  await tick(150);
  await ui.command({ name: 'settings.update', patch: { recordSessions: true } });
  hub.pushDeviceLogs('android:R5CT', [{ ts: Date.now(), level: 'info', tag: 't', message: 'now' }]);
  await tick(250);
  ui.close();
  realClosed = (await call(real.base, '/api/recordings')).body.recordings.find((r: { state: string }) => r.state !== 'recording').id;

  const file = path.resolve(__dirname, '../../../ui/dev/mock-recordings.mjs');
  const mod = (await import(pathToFileURL(file).href)) as MockModule;
  const recs = mod.createMockRecordings({ liveCounts: () => ({ logs: 10, requests: 2, errors: 0, crashes: 0 }), liveDevices: () => [] });
  mock = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!recs.handle(req, res, url.pathname, url.searchParams)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  mockClosed = (await call(mockBase, '/api/recordings')).body.recordings.find((r: { state: string }) => r.state !== 'recording').id;
});
afterAll(async () => {
  await new Promise((r) => mock?.close(r));
  await real?.close();
  hub?.dispose();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(base: string, p: string, method = 'GET'): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${base}${p}`, { method });
  const text = await res.text();
  return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text, headers: res.headers };
}

const RECORDING_REQUIRED = ['id', 'startedAt', 'lastWriteAt', 'state', 'bytes', 'counts', 'devices', 'apps'];
const RECORDING_OPTIONAL = ['endedAt', 'trimmed', 'gaps', 'serverVersion'];
const STATUS_REQUIRED = ['enabled', 'state', 'dir', 'usedBytes', 'maxDays', 'maxBytes', 'maxRecordingBytes'];
const STATUS_OPTIONAL = ['paused', 'current'];

function expectKeys(obj: Record<string, unknown>, required: string[], optional: string[], where: string): void {
  for (const k of required) expect(obj, `${where}: ${k}`).toHaveProperty(k);
  expect(Object.keys(obj).filter((k) => !required.includes(k) && !optional.includes(k)), where).toEqual([]);
}

function expectList(list: SessionRecordingList, where: string): void {
  expect(Object.keys(list).filter((k) => !['status', 'recordings', 'previous'].includes(k)), where).toEqual([]);
  expectKeys(list.status as unknown as Record<string, unknown>, STATUS_REQUIRED, STATUS_OPTIONAL, `${where} status`);
  expect(['off', 'waiting', 'recording', 'paused']).toContain(list.status.state);
  for (const n of [list.status.usedBytes, list.status.maxDays, list.status.maxBytes, list.status.maxRecordingBytes]) expect(Number.isInteger(n), where).toBe(true);
  for (const r of list.recordings) {
    expectKeys(r as unknown as Record<string, unknown>, RECORDING_REQUIRED, RECORDING_OPTIONAL, `${where} recording`);
    expect(['recording', 'ended', 'interrupted']).toContain(r.state);
    expect(Object.keys(r.counts).sort()).toEqual(['crashes', 'errors', 'logs', 'requests']);
    expect(Number.isInteger(r.bytes)).toBe(true);
    for (const d of r.devices) expect(Object.keys(d).sort()).toEqual(['id', 'name', 'platform']);
    for (const a of r.apps) expect(['bundleId', 'deviceId', 'name', 'version']).toEqual(expect.arrayContaining(Object.keys(a)));
  }
}

describe('/api/recordings: dev mock vs real server', () => {
  it('lists with the same shape', async () => {
    const r = await call(real.base, '/api/recordings');
    const m = await call(mockBase, '/api/recordings');
    expect([r.status, m.status]).toEqual([200, 200]);
    expectList(r.body, 'real');
    expectList(m.body, 'mock');
    // `previous` is a recording of an earlier run (the real one here has none: its closed recording is of this run).
    expect(['undefined', 'string']).toContain(typeof r.body.previous);
    expect(typeof m.body.previous).toBe('string');
    expect([r.body.status.state, m.body.status.state]).toEqual(['recording', 'recording']);
  });

  it('opens with the same shape and refuses the same way', async () => {
    const r = await call(real.base, `/api/recordings/${realClosed}/open`, 'POST');
    const m = await call(mockBase, `/api/recordings/${mockClosed}/open`, 'POST');
    expect([r.status, m.status]).toEqual([200, 200]);
    for (const body of [r.body, m.body]) {
      expect(Object.keys(body).filter((k) => !['recording', 'loaded', 'left', 'damaged'].includes(k))).toEqual([]);
      expect(Object.keys(body.loaded).sort()).toEqual(['logs', 'requests']);
      expect(Object.keys(body.left).sort()).toEqual(['logs', 'requests']);
      expectKeys(body.recording, RECORDING_REQUIRED, RECORDING_OPTIONAL, 'open');
    }
    expect((await call(real.base, `/api/recordings/${realClosed}/open`, 'DELETE')).body).toEqual((await call(mockBase, `/api/recordings/${mockClosed}/open`, 'DELETE')).body);
  });

  const cases: [string, (live: string) => string, string][] = [
    ['unknown id (delete)', () => '/api/recordings/20201115T184012Z-a1b2', 'DELETE'],
    ['malformed id (delete)', () => '/api/recordings/not-an-id', 'DELETE'],
    ['unknown id (open)', () => '/api/recordings/20201115T184012Z-a1b2/open', 'POST'],
    ['unknown id (export)', () => '/api/recordings/20201115T184012Z-a1b2/export', 'GET'],
    ['the live one (delete)', (live) => `/api/recordings/${live}`, 'DELETE'],
    ['the live one (open)', (live) => `/api/recordings/${live}/open`, 'POST'],
    ['the live one (export)', (live) => `/api/recordings/${live}/export`, 'GET'],
    ['wrong method (list)', () => '/api/recordings', 'POST'],
    ['wrong method (one)', (live) => `/api/recordings/${live}`, 'GET'],
    ['wrong method (open)', (live) => `/api/recordings/${live}/open`, 'PUT'],
    ['wrong method (export)', (live) => `/api/recordings/${live}/export`, 'POST'],
    ['unknown sub-path', (live) => `/api/recordings/${live}/nope`, 'GET'],
  ];
  it.each(cases)('%s: same status and code', async (_name, pathOf, method) => {
    const realLive = (await call(real.base, '/api/recordings')).body.status.current;
    const mockLive = (await call(mockBase, '/api/recordings')).body.status.current;
    const r = await call(real.base, pathOf(realLive), method);
    const m = await call(mockBase, pathOf(mockLive), method);
    expect({ status: m.status, code: m.body?.code, allow: m.headers.get('allow') }).toEqual({ status: r.status, code: r.body?.code, allow: r.headers.get('allow') });
  });

  it('exports a file named the same way', async () => {
    const r = await call(real.base, `/api/recordings/${realClosed}/export`);
    const m = await call(mockBase, `/api/recordings/${mockClosed}/export`);
    expect([r.status, m.status]).toEqual([200, 200]);
    const name = /filename="(durbun-recording-\d{8}-\d{4}\.durbun\.json)"/;
    expect(r.headers.get('content-disposition')).toMatch(name);
    expect(m.headers.get('content-disposition')).toMatch(name);
    expect([r.body.masked, m.body.masked]).toEqual([true, true]);
  });

  it('deletes with the same answer', async () => {
    const r = await call(real.base, `/api/recordings/${realClosed}`, 'DELETE');
    const m = await call(mockBase, `/api/recordings/${mockClosed}`, 'DELETE');
    expect([r.status, m.status]).toEqual([200, 200]);
    expectList(r.body, 'real');
    expectList(m.body, 'mock');
    const ra = await call(real.base, '/api/recordings', 'DELETE');
    const ma = await call(mockBase, '/api/recordings', 'DELETE');
    expect(ra.body.recordings.map((x: { state: string }) => x.state)).toEqual(['recording']);
    expect(ma.body.recordings.map((x: { state: string }) => x.state)).toEqual(['recording']);
  });
});
