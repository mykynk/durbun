/**
 * The recorder through the HTTP app: REST (/api/recordings…), an opened recording on its own WS /ui?view=<id>
 * and REST `view=<id>`, kept apart from the live data, and the commands such a window may send.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogEntry, SessionExport, SessionRecordingList, SessionRecordingOpen } from '@durbun/protocol';
import { DEFAULT_SETTINGS } from '@durbun/protocol';
import { createHub } from '../../src/hub/index';
import type { Hub } from '../../src/types';
import { silentLogger } from '../../src/util/logger';
import { connectUi, startTestApp, type TestApp } from '../http/fakes';
import { appInput, device } from '../hub/helpers';

let app: TestApp;
let hub: Hub;
const tick = (ms = 160) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  hub = createHub({ settings: { ...DEFAULT_SETTINGS }, logger: silentLogger });
  app = await startTestApp({ hub, recordings: { flushIntervalMs: 50, freeBytes: async () => 500 * 1024 ** 3 } });
});
afterEach(async () => {
  await app?.close();
  hub?.dispose();
});

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${app.base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** Capture something, then turn recording off: one closed recording to open. */
async function closedRecording(): Promise<string> {
  hub.upsertDevice(device('android:R5CT'));
  const session = hub.registerApp(appInput('android:R5CT'));
  hub.pushDeviceLogs('android:R5CT', [{ ts: Date.now(), level: 'error', tag: 'Pati', message: 'yesterday evening', pid: 8421 }]);
  hub.netRequest(session.id, { type: 'net.request', id: 'r1', ts: Date.now(), method: 'POST', url: 'https://api.pati.app/v1/login', headers: [['authorization', 'Bearer secret-token']], source: 'dart:io', body: { encoding: 'utf8', data: '{"password":"hunter2"}', size: 22 } });
  hub.netResponse(session.id, { type: 'net.response', id: 'r1', ts: Date.now() + 40, status: 500, headers: [['content-type', 'application/json']], body: { encoding: 'utf8', data: '{"error":"boom"}', size: 16 } });
  await tick(300);
  const live = (await api<SessionRecordingList>('/api/recordings')).body;
  expect(live.status.state).toBe('recording');
  const id = live.status.current!;
  const ui = await connectUi(app.port);
  await ui.synced();
  expect((await ui.command({ name: 'settings.update', patch: { recordSessions: false } })).ok).toBe(true);
  ui.close();
  for (let i = 0; i < 40; i++) {
    const list = (await api<SessionRecordingList>('/api/recordings')).body;
    if (list.status.state === 'off' && list.recordings[0]?.state === 'ended') return id;
    await tick(25);
  }
  throw new Error('the recording did not close');
}

describe('/api/recordings', () => {
  it('lists the recording being written and its status', async () => {
    const empty = await api<SessionRecordingList>('/api/recordings');
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ status: { enabled: true, state: 'waiting', maxDays: 7, maxBytes: 1024 * 1024 * 1024, maxRecordingBytes: 256 * 1024 * 1024 }, recordings: [] });
    expect(empty.body.status.dir).toBe(`${app.config.dataDir}/recordings`);
    hub.upsertDevice(device('android:R5CT'));
    hub.pushDeviceLogs('android:R5CT', [{ ts: Date.now(), level: 'info', tag: 't', message: 'hello' }]);
    await tick(300);
    const list = (await api<SessionRecordingList>('/api/recordings')).body;
    expect(list.status.state).toBe('recording');
    expect(list.recordings).toHaveLength(1);
    expect(list.recordings[0]).toMatchObject({ id: list.status.current, state: 'recording', counts: { logs: 1 } });
    expect(list.previous).toBeUndefined();
    // The one being written cannot be deleted or opened.
    expect(await api(`/api/recordings/${list.status.current}`, { method: 'DELETE' })).toMatchObject({ status: 409, body: { code: 'recorder.live' } });
    expect(await api(`/api/recordings/${list.status.current}/open`, { method: 'POST' })).toMatchObject({ status: 409, body: { code: 'recorder.live' } });
  });

  it('refuses unknown ids and wrong methods with codes', async () => {
    expect(await api('/api/recordings/20261115T184012Z-a1b2', { method: 'DELETE' })).toMatchObject({ status: 404, body: { code: 'recorder.unknown' } });
    expect(await api('/api/recordings/..%2F..%2Fetc', { method: 'DELETE' })).toMatchObject({ status: 404, body: { code: 'recorder.unknown' } });
    expect(await api('/api/recordings/20261115T184012Z-a1b2/open', { method: 'POST' })).toMatchObject({ status: 404, body: { code: 'recorder.unknown' } });
    expect(await api('/api/recordings/20261115T184012Z-a1b2/export')).toMatchObject({ status: 404, body: { code: 'recorder.unknown' } });
    expect(await api('/api/recordings', { method: 'POST' })).toMatchObject({ status: 405, body: { code: 'method.notAllowed' } });
    expect(await api('/api/network/x?view=20261115T184012Z-a1b2')).toMatchObject({ status: 404, body: { code: 'recorder.notOpen' } });
  });

  it('opens a recording apart from the live data, on its own socket and REST', async () => {
    const id = await closedRecording();
    const opened = await api<SessionRecordingOpen>(`/api/recordings/${id}/open`, { method: 'POST' });
    expect(opened.status).toBe(200);
    expect(opened.body.recording).toMatchObject({ id, state: 'ended', counts: { logs: 1, requests: 1, errors: 1 } });
    expect(opened.body.loaded.requests).toBe(1);
    expect(opened.body.left).toEqual({ logs: 0, requests: 0 });

    const view = await connectUi(app.port, undefined, `?view=${id}`);
    await view.synced();
    const hello = await view.waitForType('hello');
    expect(hello.recording?.id).toBe(id);
    const snap = await view.waitForType('snapshot');
    expect(snap.devices.map((d) => [d.id.startsWith('import:'), d.stateCode])).toEqual([[true, 'device.imported']]);
    const lines = view.messages.flatMap((m) => (m.type === 'history' ? m.logs : [])) as LogEntry[];
    expect(lines.some((l) => l.message === 'yesterday evening')).toBe(true);
    const netId = snap.network[0]!.id;

    // REST of the view: the request with its bodies; the live hub does not know it.
    const detail = await api<{ status: number; responseBody: { data: string } }>(`/api/network/${encodeURIComponent(netId)}?view=${id}`);
    expect(detail.body).toMatchObject({ status: 500, responseBody: { data: '{"error":"boom"}' } });
    expect((await api(`/api/network/${encodeURIComponent(netId)}`)).status).toBe(404);
    const exp = await api<SessionExport>(`/api/export?view=${id}`);
    expect(exp.body.masked).toBe(true);
    expect(exp.body.logs.some((l) => l.message === 'yesterday evening')).toBe(true);

    // Live data keeps flowing in the live hub only.
    const live = await connectUi(app.port);
    await live.synced();
    const from = view.messages.length;
    hub.pushDeviceLogs('android:R5CT', [{ ts: Date.now(), level: 'info', tag: 't', message: 'live now' }]);
    await live.waitFor((m) => m.type === 'batch' && !!m.logs?.some((l) => l.message === 'live now'));
    await tick(200);
    expect(view.messages.slice(from).some((m) => m.type === 'batch' && m.logs?.some((l) => l.message === 'live now'))).toBe(false);
    expect(live.messages.some((m) => m.type === 'hello' && m.recording)).toBe(false);

    // Device and app commands are refused in a recording; server-wide ones work.
    expect(await view.command({ name: 'device.action', deviceId: snap.devices[0]!.id, action: 'screenshot' })).toMatchObject({ ok: false, code: 'recorder.notLive' });
    expect(await view.command({ name: 'marker.add', label: 'x' })).toMatchObject({ ok: false, code: 'recorder.notLive' });
    const mocks = await view.command({ name: 'mocks.set', rules: [] });
    expect(mocks.ok).toBe(true);
    // A setting changed from either window reaches both.
    await live.command({ name: 'settings.update', patch: { logcatTail: 123 } });
    await view.waitFor((m) => m.type === 'settings' && m.settings.logcatTail === 123);
    live.close();
    view.close();
  });

  it('exports a recording (masked unless asked) and deletes it (its windows go back to live)', async () => {
    const id = await closedRecording();
    const masked = await api<SessionExport>(`/api/recordings/${id}/export`);
    expect(masked.status).toBe(200);
    expect(masked.body).toMatchObject({ format: 'durbun-session', masked: true });
    expect(JSON.stringify(masked.body)).not.toContain('hunter2');
    const raw = await api<SessionExport>(`/api/recordings/${id}/export?mask=0`);
    expect(JSON.stringify(raw.body)).toContain('hunter2');

    await api(`/api/recordings/${id}/open`, { method: 'POST' });
    const view = await connectUi(app.port, undefined, `?view=${id}`);
    await view.synced();
    const after = await api<SessionRecordingList>(`/api/recordings/${id}`, { method: 'DELETE' });
    expect(after.status).toBe(200);
    expect(after.body.recordings).toEqual([]);
    expect(await view.waitClose()).toBe(4004);
    // Reconnecting with the deleted id lands on the live data (no `recording` in the hello).
    const again = await connectUi(app.port, undefined, `?view=${id}`);
    const hello = await again.waitForType('hello');
    expect(hello.recording).toBeUndefined();
    again.close();
  });

  it('delete all keeps the recording being written', async () => {
    const first = await closedRecording();
    const ui = await connectUi(app.port);
    await ui.synced();
    await ui.command({ name: 'settings.update', patch: { recordSessions: true } });
    hub.pushDeviceLogs('android:R5CT', [{ ts: Date.now(), level: 'info', tag: 't', message: 'today' }]);
    await tick(300);
    const before = (await api<SessionRecordingList>('/api/recordings')).body;
    expect(before.recordings.map((r) => r.state).sort()).toEqual(['ended', 'recording']);
    const after = (await api<SessionRecordingList>('/api/recordings', { method: 'DELETE' })).body;
    expect(after.recordings.map((r) => r.id)).toEqual([before.status.current]);
    expect(after.recordings.some((r) => r.id === first)).toBe(false);
    ui.close();
  });

  it('closes a view when its window goes back to live', async () => {
    const id = await closedRecording();
    await api(`/api/recordings/${id}/open`, { method: 'POST' });
    expect(await api(`/api/recordings/${id}/open`, { method: 'DELETE' })).toMatchObject({ status: 200, body: { ok: true } });
    // Opening again works (loaded on demand).
    expect((await api(`/api/recordings/${id}/open`, { method: 'POST' })).status).toBe(200);
  });
});

describe('settings of the recorder', () => {
  it('clamps the limits like the other numeric settings', async () => {
    const ui = await connectUi(app.port);
    await ui.synced();
    const r = await ui.command({ name: 'settings.update', patch: { recordingsMaxDays: 500, recordingsMaxMB: 10 } });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ recordingsMaxDays: 90, recordingsMaxMB: 100 });
    const list = (await api<SessionRecordingList>('/api/recordings')).body;
    expect(list.status).toMatchObject({ maxDays: 90, maxBytes: 100 * 1024 * 1024, maxRecordingBytes: 50 * 1024 * 1024 });
    ui.close();
  });
});

