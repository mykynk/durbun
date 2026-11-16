// @vitest-environment node
/**
 * The media library store, and the list shape on both sides: the REAL server's MediaLibrary (loaded from its sources
 * at run time, as data/serverContract.test.ts does) and the dev mock (dev/mock-media.mjs) must give the same fields.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaItem, MediaList } from '@durbun/protocol';
import { addFromReply, deleteMedia, DELETE_UNDO_MS, isMediaItem, mediaRefOf, openMediaRef, parseMediaList, useMediaLibrary, useMediaViewer, visibleItems } from './store';
// @ts-expect-error — plain .mjs dev tool without types
import { createMockMedia, MEDIA_POLICY } from '../../../../dev/mock-media.mjs';

const SERVER = new URL('../../../../../server/', import.meta.url).pathname;
const load = <T>(file: string): Promise<T> => import(/* @vite-ignore */ `${SERVER}${file}`) as Promise<T>;

interface Lib {
  ready: Promise<void>;
  ingest(deviceId: string, action: string, result: unknown): Promise<{ data: { media: MediaItem } }>;
  list(deviceId?: string): MediaList;
  dispose(): void;
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function reset(): void {
  useMediaLibrary.setState({ status: 'idle', items: [], usedBytes: 0, total: 0, pendingDelete: {}, error: undefined });
  useMediaViewer.setState({ open: null });
}

const item = (id: string, patch: Partial<MediaItem> = {}): MediaItem => ({
  id,
  kind: 'screenshot',
  deviceId: 'android:1',
  ts: 1_000,
  bytes: 10,
  url: `/api/media/${id}`,
  fileName: `${id}.png`,
  ...patch,
});

beforeEach(reset);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('list shape: real server and dev mock', () => {
  it('the server MediaLibrary list and the mock list carry the same fields and parse whole', async () => {
    const { MediaLibrary } = await load<{ MediaLibrary: new (deps: unknown) => Lib }>('src/http/media.ts');
    const { silentLogger } = await load<{ silentLogger: unknown }>('src/util/logger.ts');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'durbun-ui-media-'));
    const temp = path.join(dir, 'tmp');
    await mkdir(temp, { recursive: true });
    const hub = {
      getDevice: () => ({ id: 'android:1', name: 'Pixel 8', platform: 'android' }),
      pushSystemLog: () => ({ id: 7 }),
    };
    const lib = new MediaLibrary({ dir: path.join(dir, 'media'), tempDir: temp, hub, logger: silentLogger, enforceIntervalMs: 0 });
    try {
      await lib.ready;
      await writeFile(path.join(temp, 'a.png'), PNG);
      await lib.ingest('android:1', 'screenshot', { ok: true, data: { url: '/api/files/a.png', file: path.join(temp, 'a.png'), width: 1, height: 1 } });
      await writeFile(path.join(temp, 'r.mp4'), Buffer.alloc(64, 1));
      await lib.ingest('android:1', 'screen-record', { ok: true, data: { url: '/api/files/r.mp4', file: path.join(temp, 'r.mp4'), durationSec: 9 } });
      const server = JSON.parse(JSON.stringify(lib.list())) as MediaList;

      const mock = createMockMedia({ png: () => PNG, devices: [{ id: 'android:1', name: 'Pixel 8', platform: 'android' }] });
      mock.add({ id: 'android:1', name: 'Pixel 8', platform: 'android' }, 'screenshot', { logId: 7 });
      mock.add({ id: 'android:1', name: 'Pixel 8', platform: 'android' }, 'recording', { durationSec: 9, logId: 8 });
      const fromMock = mock.list() as MediaList;

      expect(Object.keys(fromMock).sort()).toEqual(Object.keys(server).sort());
      expect(fromMock.policy).toEqual(server.policy);
      expect(MEDIA_POLICY).toEqual(server.policy);
      for (const kind of ['screenshot', 'recording'] as const) {
        const s = server.items.find((i) => i.kind === kind)!;
        const m = fromMock.items.find((i) => i.kind === kind)!;
        expect(Object.keys(m).sort()).toEqual(Object.keys(s).sort());
      }
      expect(parseMediaList(server).items).toHaveLength(2);
      expect(parseMediaList(fromMock).items).toHaveLength(2);
      expect(server.items.every(isMediaItem)).toBe(true);
    } finally {
      lib.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parseMediaList drops what it does not understand', () => {
    const parsed = parseMediaList({ items: [item('m-1'), { id: 'x' }, null], policy: { maxAgeDays: 30 }, usedBytes: 'a' });
    expect(parsed.items.map((i) => i.id)).toEqual(['m-1']);
    expect(parsed.policy).toBeUndefined();
    expect(parsed.usedBytes).toBe(0);
    expect(parsed.total).toBe(1);
  });
});

describe('media store', () => {
  it('a reply with data.media adds the server item once; an older server gives a window-only item', () => {
    const m = item('m-a', { ts: 2_000 });
    expect(addFromReply('android:1', 'screenshot', { url: '/api/files/a.png', media: m })?.id).toBe('m-a');
    expect(addFromReply('android:1', 'screenshot', { url: '/api/files/a.png', media: m })?.id).toBe('m-a');
    expect(useMediaLibrary.getState()).toMatchObject({ total: 1, usedBytes: 10 });
    const local = addFromReply('android:1', 'screenshot', { url: '/api/files/b.png', file: '/x/tmp/b.png', width: 2, height: 3 }, { ts: 3_000 });
    expect(local).toMatchObject({ local: true, url: '/api/files/b.png', fileName: 'b.png', width: 2, height: 3 });
    expect(useMediaLibrary.getState().items.map((i) => i.id)).toEqual([local!.id, 'm-a']);
    expect(addFromReply('android:1', 'screenshot', null)).toBeNull();
  });

  it('delete hides at once, Undo brings it back, otherwise DELETE goes after the undo window', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response(JSON.stringify({ removed: 1 }), { status: 200 });
    }));
    useMediaLibrary.setState({ status: 'ready', items: [item('m-a'), item('m-b')], total: 2, usedBytes: 20 });
    useMediaViewer.setState({ open: { id: 'm-a' } });
    deleteMedia(['m-a']);
    expect(visibleItems().map((i) => i.id)).toEqual(['m-b']);
    // The viewer steps to the neighbour instead of showing a deleted item.
    expect(useMediaViewer.getState().open).toEqual({ id: 'm-b' });
    await vi.advanceTimersByTimeAsync(DELETE_UNDO_MS + 10);
    expect(calls).toEqual(['DELETE /api/media/m-a']);
    expect(useMediaLibrary.getState()).toMatchObject({ total: 1, usedBytes: 10, pendingDelete: {} });
  });

  it('a delete of an item another window already removed counts as done; a real failure brings it back', async () => {
    vi.useFakeTimers();
    let status = 404;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'x', code: status === 404 ? 'media.unknown' : 'internal' }), { status })));
    useMediaLibrary.setState({ status: 'ready', items: [item('m-a'), item('m-b')], total: 2 });
    deleteMedia(['m-a']);
    await vi.advanceTimersByTimeAsync(DELETE_UNDO_MS + 10);
    expect(useMediaLibrary.getState().items.map((i) => i.id)).toEqual(['m-b']);
    status = 500;
    deleteMedia(['m-b']);
    await vi.advanceTimersByTimeAsync(DELETE_UNDO_MS + 10);
    expect(visibleItems().map((i) => i.id)).toEqual(['m-b']);
  });

  it('a marker whose item is gone opens the viewer\'s "no longer there" state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [item('m-b')], policy: MEDIA_POLICY, usedBytes: 10, total: 1 }), { status: 200 })));
    const entry = { code: 'media.screenshot', data: { media: { id: 'm-a', kind: 'screenshot' } } };
    const ref = mediaRefOf(entry)!;
    expect(ref).toEqual({ id: 'm-a', kind: 'screenshot' });
    await openMediaRef(ref, { ts: 5, deviceId: 'import:1' });
    expect(useMediaViewer.getState().open).toEqual({ id: 'm-a', missing: { id: 'm-a', kind: 'screenshot', ts: 5, deviceId: 'import:1' } });
    await openMediaRef({ id: 'm-b', kind: 'screenshot' });
    expect(useMediaViewer.getState().open).toEqual({ id: 'm-b' });
    expect(mediaRefOf({ code: 'marker', data: { media: { id: 'm-a', kind: 'screenshot' } } })).toBeUndefined();
    expect(mediaRefOf({ code: 'media.recording', data: { media: { id: 3 } } })).toBeUndefined();
  });
});
