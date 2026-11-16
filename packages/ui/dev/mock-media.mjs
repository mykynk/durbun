/**
 * Media library of the dev mock (the real one: packages/server/src/http/media.ts): screenshots and recordings with
 * the server's `MediaItem` / `MediaList` shapes, GET / DELETE /api/media, the files at /api/media/:id. Nothing is
 * written to disk. Screenshots are the mock's phone-shaped PNG; recordings serve `--sample-video <file>` (any small
 * .mp4) when given, else 404 (the viewer's "file not on the disk" state).
 *
 * Seeded: two screenshots and a recording of the Pixel (today), one screenshot of the simulator (yesterday), two of a
 * Galaxy that is not connected (last week: only the library shows them) and one whose file is gone.
 */
import { readFileSync, statSync } from 'node:fs';

export const MEDIA_POLICY = { maxAgeDays: 30, maxBytes: 2 * 1024 * 1024 * 1024, maxItems: 1000 };

const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};
const slug = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'device';
export const mediaClock = (sec) => `${Math.floor(sec / 60)}:${pad(Math.round(sec) % 60)}`;

let seq = 0;

/**
 * @param {{ png: () => Buffer, sampleVideo?: string, devices: { id: string, name: string, platform: string }[] }} opts
 */
export function createMockMedia(opts) {
  /** @type {any[]} newest first */
  let items = [];
  const gone = new Set();
  let video;
  if (opts.sampleVideo) {
    try {
      video = { data: readFileSync(opts.sampleVideo), size: statSync(opts.sampleVideo).size, type: opts.sampleVideo.endsWith('.mov') ? 'video/quicktime' : 'video/mp4' };
    } catch {
      video = undefined;
    }
  }

  /** Same fields, same order as MediaLibrary.publicItem on the server. */
  function add(d, kind, extra = {}) {
    const ts = extra.ts ?? Date.now();
    const id = `m-${ts.toString(36)}-${(0xa00000 + ++seq).toString(16)}`;
    const ext = kind === 'screenshot' ? 'png' : d.platform === 'ios' ? 'mov' : 'mp4';
    const item = {
      id,
      kind,
      deviceId: d.id,
      ts,
      bytes: kind === 'screenshot' ? opts.png().length : video?.size ?? 2_400_000 + seq * 13_000,
      fileName: `${kind}-${slug(d.name)}-${stamp(ts)}.${ext}`,
      deviceName: d.name,
      platform: d.platform,
      ...(kind === 'recording' ? { endTs: ts + (extra.durationSec ?? 12) * 1000, durationSec: extra.durationSec ?? 12 } : { width: 270, height: 585 }),
      ...(extra.logId ? { logId: extra.logId } : {}),
      url: `/api/media/${id}`,
    };
    items = [item, ...items].sort((a, b) => b.ts - a.ts);
    return item;
  }

  function seed(now = Date.now()) {
    const [pixel, sim] = opts.devices;
    const galaxy = { id: 'android:RZ8T61A54XK', name: 'Galaxy A54', platform: 'android' };
    const DAY = 24 * 3600_000;
    add(galaxy, 'screenshot', { ts: now - 6 * DAY - 3_600_000 });
    const old = add(galaxy, 'screenshot', { ts: now - 6 * DAY });
    gone.add(old.id);
    add(galaxy, 'screenshot', { ts: now - 5 * DAY });
    if (sim) add(sim, 'screenshot', { ts: now - DAY - 1_800_000 });
    if (pixel) {
      add(pixel, 'recording', { ts: now - 50 * 60_000, durationSec: 42 });
      add(pixel, 'screenshot', { ts: now - 40 * 60_000 });
      add(pixel, 'screenshot', { ts: now - 12 * 60_000 });
    }
  }

  function list(deviceId) {
    const all = items;
    return {
      items: deviceId ? all.filter((i) => i.deviceId === deviceId) : all,
      policy: { ...MEDIA_POLICY },
      usedBytes: all.reduce((n, i) => n + i.bytes, 0),
      total: all.length,
    };
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  /** Answers /api/media*; false for any other path. */
  function handle(req, res, p, url) {
    if (p !== '/api/media' && !p.startsWith('/api/media/')) return false;
    const method = req.method ?? 'GET';
    if (p === '/api/media') {
      if (method === 'GET') return send(res, 200, list(url.searchParams.get('deviceId') || undefined)), true;
      if (method === 'DELETE') {
        const deviceId = url.searchParams.get('deviceId');
        if (!deviceId) return send(res, 400, { error: 'deviceId is required', code: 'media.deviceRequired' }), true;
        const before = items.length;
        items = items.filter((i) => i.deviceId !== deviceId);
        return send(res, 200, { removed: before - items.length }), true;
      }
      return send(res, 405, { error: 'Method not allowed', code: 'method.notAllowed' }), true;
    }
    const id = decodeURIComponent(p.slice('/api/media/'.length));
    const item = items.find((i) => i.id === id);
    if (method === 'DELETE') {
      if (!item) return send(res, 404, { error: 'Media item not found', code: 'media.unknown' }), true;
      items = items.filter((i) => i !== item);
      return send(res, 200, { removed: 1 }), true;
    }
    if (!item) return send(res, 404, { error: 'Media item not found', code: 'media.unknown' }), true;
    if (gone.has(id) || (item.kind === 'recording' && !video)) return send(res, 404, { error: 'The file of this item is gone', code: 'media.fileMissing' }), true;
    const body = item.kind === 'screenshot' ? opts.png() : video.data;
    const headers = { 'Content-Type': item.kind === 'screenshot' ? 'image/png' : video.type, 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' };
    if (url.searchParams.get('download') === '1') headers['Content-Disposition'] = `attachment; filename="${item.fileName}"`;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && body.length) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 });
      res.end(method === 'HEAD' ? undefined : body.subarray(start, end + 1));
      return true;
    }
    res.writeHead(200, { ...headers, 'Content-Length': body.length });
    res.end(method === 'HEAD' ? undefined : body);
    return true;
  }

  return { add, seed, list, handle };
}
