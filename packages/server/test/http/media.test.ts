import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceActionResult, DeviceInfo, LogEntry, MediaItem, MediaList, MockRule } from '@durbun/protocol';
import type { SystemLogInput } from '../../src/types';
import { clockText, isMediaId, MediaLibrary, MEDIA_INDEX_FILE } from '../../src/http/media';
import { createCommandRouter } from '../../src/http/commands';
import { silentLogger } from '../../src/util/logger';
import { connectUi, FakeDriver, FakeHub, makeTempDir, sampleDevice, startTestApp, type TestApp } from './fakes';

// 1×1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

class MarkerHub {
  lines: { deviceId: string; input: SystemLogInput }[] = [];
  devices = new Map<string, DeviceInfo>();
  getDevice(id: string): DeviceInfo | undefined {
    return this.devices.get(id);
  }
  pushSystemLog(deviceId: string, input: SystemLogInput): LogEntry {
    this.lines.push({ deviceId, input });
    return { id: 100 + this.lines.length, ts: Date.now(), deviceId, source: 'system', level: 'info', tag: 'durbun', message: input.message };
  }
}

interface Rig {
  dir: string;
  temp: string;
  media: string;
  hub: MarkerHub;
  lib: MediaLibrary;
  now: { t: number };
}

const rigs: Rig[] = [];
let app: TestApp | undefined;

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.lib.dispose();
    await rm(r.dir, { recursive: true, force: true });
  }
  await app?.close();
  app = undefined;
});

async function rig(policy?: ConstructorParameters<typeof MediaLibrary>[0]['policy'], existing?: { dir: string; hub?: MarkerHub; now?: { t: number } }): Promise<Rig> {
  const dir = existing?.dir ?? (await makeTempDir('durbun-media-'));
  const temp = path.join(dir, 'tmp');
  const media = path.join(dir, 'media');
  await mkdir(temp, { recursive: true });
  const hub = existing?.hub ?? new MarkerHub();
  hub.devices.set('android:R5CT', sampleDevice('android:R5CT', { name: 'Pixel 8' }));
  const now = existing?.now ?? { t: Date.UTC(2026, 10, 16, 11, 2, 10) };
  const lib = new MediaLibrary({ dir: media, tempDir: temp, hub, logger: silentLogger, policy, now: () => now.t, enforceIntervalMs: 0 });
  await lib.ready;
  const r = { dir, temp, media, hub, lib, now };
  rigs.push(r);
  return r;
}

async function tempShot(r: Rig, name = `screenshot-Pixel-8-${r.now.t}.png`, bytes: Buffer = PNG): Promise<DeviceActionResult> {
  const file = path.join(r.temp, name);
  await writeFile(file, bytes);
  return { ok: true, code: 'action.screenshot.saved', data: { url: `/api/files/${name}`, file, width: 1080, height: 2400 } };
}

describe('MediaLibrary', () => {
  it('keeps a screenshot from the temp folder, marks the log timeline and leaves the reply url alone', async () => {
    const r = await rig();
    const result = await tempShot(r);
    const out = await r.lib.ingest('android:R5CT', 'screenshot', result);
    const data = out.data as { url: string; file: string; media: MediaItem };
    expect(data.url).toBe((result.data as { url: string }).url);
    expect(data.file).toBe((result.data as { file: string }).file);
    expect(isMediaId(data.media.id)).toBe(true);
    expect(data.media).toMatchObject({
      kind: 'screenshot',
      deviceId: 'android:R5CT',
      deviceName: 'Pixel 8',
      platform: 'android',
      width: 1080,
      height: 2400,
      bytes: PNG.length,
      url: `/api/media/${data.media.id}`,
      logId: 101,
    });
    expect(data.media.fileName).toMatch(/^screenshot-Pixel-8-\d{8}-\d{6}\.png$/);
    expect(r.hub.lines).toEqual([
      {
        deviceId: 'android:R5CT',
        input: { message: 'Screenshot · Pixel 8', level: 'info', kind: 'marker', code: 'media.screenshot', params: { device: 'Pixel 8' }, data: { media: { id: data.media.id, kind: 'screenshot' } } },
      },
    ]);
    // A hard link (or copy): the temp cleanup removing its name does not touch the library's.
    await rm((result.data as { file: string }).file);
    expect(await readFile(r.lib.filePath(data.media.id)!)).toEqual(PNG);
    const index = JSON.parse(await readFile(path.join(r.media, MEDIA_INDEX_FILE), 'utf8'));
    expect(index.items).toHaveLength(1);
  });

  it('adds a recording once although the start and the stop reply carry the same file', async () => {
    const r = await rig();
    const file = path.join(r.temp, 'recording-Pixel-8-1.mp4');
    await writeFile(file, Buffer.alloc(4096, 1));
    const reply: DeviceActionResult = { ok: true, code: 'action.recording.saved', data: { url: '/api/files/recording-Pixel-8-1.mp4', file, durationSec: 42, endedBy: 'stop' } };
    const a = await r.lib.ingest('android:R5CT', 'screen-record-stop', reply);
    const b = await r.lib.ingest('android:R5CT', 'screen-record', reply);
    const ma = (a.data as { media: MediaItem }).media;
    expect((b.data as { media: MediaItem }).media.id).toBe(ma.id);
    expect(ma).toMatchObject({ kind: 'recording', durationSec: 42, endTs: r.now.t, ts: r.now.t - 42_000 });
    expect(r.hub.lines).toHaveLength(1);
    expect(r.hub.lines[0]!.input).toMatchObject({ code: 'media.recording', params: { device: 'Pixel 8', duration: '0:42' } });
    expect(r.lib.list().items).toHaveLength(1);
  });

  it('leaves failed replies, other actions and files outside the temp folder alone', async () => {
    const r = await rig();
    const failed: DeviceActionResult = { ok: false, code: 'action.failed', error: 'no' };
    expect(await r.lib.ingest('android:R5CT', 'screenshot', failed)).toBe(failed);
    const shot = await tempShot(r);
    expect(await r.lib.ingest('android:R5CT', 'open-url', shot)).toBe(shot);
    const outside = path.join(r.dir, 'elsewhere.png');
    await writeFile(outside, PNG);
    const foreign: DeviceActionResult = { ok: true, data: { url: '/x', file: outside } };
    expect(await r.lib.ingest('android:R5CT', 'screenshot', foreign)).toBe(foreign);
    const traversal: DeviceActionResult = { ok: true, data: { url: '/x', file: path.join(r.temp, '..', 'elsewhere.png') } };
    expect(await r.lib.ingest('android:R5CT', 'screenshot', traversal)).toBe(traversal);
    const missing: DeviceActionResult = { ok: true, data: { url: '/x', file: path.join(r.temp, 'gone.png') } };
    expect(await r.lib.ingest('android:R5CT', 'screenshot', missing)).toEqual(missing);
    expect(r.lib.list().items).toEqual([]);
    expect(r.hub.lines).toEqual([]);
  });

  it('removes the oldest past the count and the size, and anything older than the age limit', async () => {
    const r = await rig({ maxItems: 2, maxBytes: 10_000, maxAgeDays: 30 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      r.now.t += 1000;
      const out = await r.lib.ingest('android:R5CT', 'screenshot', await tempShot(r, `s${i}.png`));
      ids.push((out.data as { media: MediaItem }).media.id);
    }
    expect(r.lib.list().items.map((i) => i.id)).toEqual([ids[2], ids[1]]);
    expect(await readdir(r.media)).not.toContain(path.basename(r.lib.filePath(ids[0]!) ?? `${ids[0]}.png`));
    // Size: a 9.96 KB item pushes both older ones out, never the new one.
    r.now.t += 1000;
    const big = await r.lib.ingest('android:R5CT', 'screenshot', await tempShot(r, 'big.png', Buffer.alloc(9_960, 7)));
    expect(r.lib.list().items.map((i) => i.id)).toEqual([(big.data as { media: MediaItem }).media.id]);
    // Age: 31 days later the hourly check removes it.
    r.now.t += 31 * 24 * 3600_000;
    expect(await r.lib.enforce()).toBe(1);
    expect(r.lib.list()).toMatchObject({ items: [], usedBytes: 0, total: 0, policy: { maxItems: 2, maxBytes: 10_000, maxAgeDays: 30 } });
  });

  it('survives a restart; items whose file was deleted by hand and stray files go', async () => {
    const r = await rig();
    const a = (await r.lib.ingest('android:R5CT', 'screenshot', await tempShot(r, 'a.png'))).data as { media: MediaItem };
    r.now.t += 1000;
    const b = (await r.lib.ingest('android:R5CT', 'screenshot', await tempShot(r, 'b.png'))).data as { media: MediaItem };
    await rm(r.lib.filePath(a.media.id)!);
    await writeFile(path.join(r.media, 'm-zzzzzzzz-abcdef.png'), PNG);
    await writeFile(path.join(r.media, 'notes.txt'), 'mine');
    r.lib.dispose();
    const again = await rig(undefined, { dir: r.dir, now: r.now });
    expect(again.lib.list().items.map((i) => i.id)).toEqual([b.media.id]);
    expect(again.lib.get(b.media.id)).toEqual(b.media);
    const names = await readdir(r.media);
    expect(names).not.toContain('m-zzzzzzzz-abcdef.png');
    expect(names).toContain('notes.txt');
    const index = JSON.parse(await readFile(path.join(r.media, MEDIA_INDEX_FILE), 'utf8'));
    expect(index.items.map((i: { id: string }) => i.id)).toEqual([b.media.id]);
  });

  it('ignores an index entry that would point outside the media folder', async () => {
    const r = await rig();
    await mkdir(r.media, { recursive: true });
    await writeFile(path.join(r.dir, 'secret.png'), PNG);
    const bad = { id: 'm-abcdefgh-abcdef', kind: 'screenshot', deviceId: 'd', ts: 1, bytes: 1, file: '../secret.png', fileName: 'x.png' };
    await writeFile(path.join(r.media, MEDIA_INDEX_FILE), JSON.stringify({ version: 1, items: [bad] }));
    r.lib.dispose();
    const again = await rig(undefined, { dir: r.dir, now: r.now });
    expect(again.lib.list().items).toEqual([]);
  });

  it('formats clock texts', () => {
    expect(clockText(0)).toBe('0:00');
    expect(clockText(42)).toBe('0:42');
    expect(clockText(3609)).toBe('1:00:09');
  });
});

describe('command router: media from UI windows only', () => {
  it('a flow run (client id -1) gets the reply untouched, a window gets data.media', async () => {
    const r = await rig();
    const hub = new FakeHub();
    hub.devices.set('android:R5CT', sampleDevice('android:R5CT'));
    const driver = new FakeDriver('android', 'android:');
    const router = createCommandRouter({
      hub,
      sdk: { sendCommand: async () => ({ ok: true }) },
      config: { updateSettings: () => ({ settings: hub.settings, changed: [], adjusted: [], ignored: [] }), setMocks: (x: MockRule[]) => x, settings: hub.settings, mocks: [], mocksRevision: 0 },
      logger: silentLogger,
      drivers: () => [driver],
      vm: null,
      setDemo: async () => false,
      runDoctor: async () => [],
      onLanChanged: async () => undefined,
      media: r.lib,
    });
    driver.result = await tempShot(r, 'flow.png');
    const flow = await router.handle({ name: 'device.action', deviceId: 'android:R5CT', action: 'screenshot', params: {} }, { id: -1, notice: () => undefined });
    expect(flow.ok).toBe(true);
    expect((flow.data as Record<string, unknown>).media).toBeUndefined();
    driver.result = await tempShot(r, 'window.png');
    const win = await router.handle({ name: 'device.action', deviceId: 'android:R5CT', action: 'screenshot', params: {} }, { id: 3, notice: () => undefined });
    expect((win.data as { media: MediaItem }).media.kind).toBe('screenshot');
    expect(r.lib.list().items).toHaveLength(1);
  });
});

/** Raw request (no client-side path normalization). */
function raw(port: number, method: string, pathName: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('/api/media (real handler)', () => {
  async function takeShot(t: TestApp, name: string): Promise<MediaItem> {
    const file = path.join(t.config.tempDir, name);
    await writeFile(file, PNG);
    t.android.result = { ok: true, code: 'action.screenshot.saved', data: { url: `/api/files/${name}`, file, width: 1, height: 1 } };
    const ui = await connectUi(t.port);
    await ui.synced();
    const reply = await ui.command({ name: 'device.action', deviceId: 'android:R5CT1234', action: 'screenshot', params: {} });
    ui.close();
    expect(reply).toMatchObject({ ok: true, code: 'action.screenshot.saved' });
    return (reply as unknown as { data: { media: MediaItem } }).data.media;
  }

  it('lists, serves (with ranges and as a download) and deletes what a window took', async () => {
    app = await startTestApp();
    app.hub.devices.set('android:R5CT1234', sampleDevice());
    const item = await takeShot(app, 'shot-1.png');
    expect(item.url).toBe(`/api/media/${item.id}`);
    const marker = app.hub.logs.find((l) => l.code === 'media.screenshot');
    expect(marker).toMatchObject({ kind: 'marker', deviceId: 'android:R5CT1234' });

    const list = (await (await fetch(`${app.base}/api/media`)).json()) as MediaList;
    expect(list).toMatchObject({ total: 1, usedBytes: PNG.length, policy: { maxAgeDays: 30, maxBytes: 2 * 1024 ** 3, maxItems: 1000 } });
    expect(list.items).toEqual([item]);
    expect(((await (await fetch(`${app.base}/api/media?deviceId=ios:other`)).json()) as MediaList).items).toEqual([]);

    const file = await fetch(`${app.base}${item.url}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
    const part = await raw(app.port, 'GET', item.url, { Range: 'bytes=0-7' });
    expect(part.status).toBe(206);
    expect(part.body).toEqual(PNG.subarray(0, 8));
    const dl = await fetch(`${app.base}${item.url}?download=1`);
    expect(dl.headers.get('content-disposition')).toContain(item.fileName);

    const del = await fetch(`${app.base}${item.url}`, { method: 'DELETE' });
    expect(await del.json()).toEqual({ removed: 1 });
    const again = await fetch(`${app.base}${item.url}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ code: 'media.unknown' });
    expect((await fetch(`${app.base}${item.url}`)).status).toBe(404);
  });

  it('deletes a device\'s whole set; refuses odd ids, missing deviceId and other methods', async () => {
    app = await startTestApp();
    app.hub.devices.set('android:R5CT1234', sampleDevice());
    await takeShot(app, 'a.png');
    await takeShot(app, 'b.png');
    const noDevice = await fetch(`${app.base}/api/media`, { method: 'DELETE' });
    expect(noDevice.status).toBe(400);
    expect(await noDevice.json()).toMatchObject({ code: 'media.deviceRequired' });
    const all = await fetch(`${app.base}/api/media?deviceId=android:R5CT1234`, { method: 'DELETE' });
    expect(await all.json()).toEqual({ removed: 2 });
    for (const bad of ['/api/media/..%2Fsettings.json', '/api/media/index.json', '/api/media/m-1-2']) {
      const res = await raw(app.port, 'GET', bad);
      expect(res.status).toBe(404);
    }
    expect((await raw(app.port, 'POST', '/api/media')).status).toBe(405);
    const st = await stat(path.join(app.config.dataDir, 'media'));
    expect(st.isDirectory()).toBe(true);
  });
});
