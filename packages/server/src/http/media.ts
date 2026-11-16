/**
 * Media library: screenshots and screen recordings a window took, kept past the temp cleanup.
 *
 *   <dataDir>/media/<id>.<ext>   the files (a hard link to the driver's temp file, else a copy)
 *   <dataDir>/media/index.json   MediaItem list (atomic writes)
 *
 * A successful `screenshot` / `screen-record` / `screen-record-stop` from a UI window (not a flow run, which keeps
 * its own evidence) is added here, gets a marker line on the device's log timeline (`media.screenshot` /
 * `media.recording`, `data.media`) and comes back in the reply as `data.media`. The reply's own `url` / `file`
 * stay the temp copy, so everything that reads them (bug report, flows) works as before.
 *
 * Bounded (config.ts MEDIA_*): items older than MEDIA_MAX_AGE_DAYS go, then the oldest while there are more than
 * MEDIA_MAX_ITEMS or more than MEDIA_MAX_BYTES; checked at start, after each new item and hourly.
 *
 *   GET    /api/media[?deviceId=]     MediaList (newest first)
 *   GET    /api/media/:id[?download=1] the file (byte ranges for video seeking)
 *   DELETE /api/media/:id             { removed: 1 } | 404 media.unknown
 *   DELETE /api/media?deviceId=…      { removed: n } (every item of that device)
 */
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { DeviceActionResult, MediaItem, MediaKind, MediaList, MediaPolicy, MediaRef } from '@durbun/protocol';
import { isPlainObject, MEDIA_MAX_AGE_DAYS, MEDIA_MAX_BYTES, MEDIA_MAX_ITEMS, writeFileAtomic } from '../config';
import { fileSafe } from '../platform/shared/text';
import type { Hub, Logger } from '../types';
import { isInside, sendFile, statFile } from './static';
import { contentDisposition, errorMessage, HttpError, isTruthyParam, queryString, sendJson } from './util';

export const MEDIA_INDEX_FILE = 'index.json';
const INDEX_VERSION = 1;
const ENFORCE_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** "m-<time36>-<6 hex>" — the only ids the routes accept. */
const MEDIA_ID = /^m-[0-9a-z]{6,12}-[0-9a-f]{6}$/;
const EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.mp4', '.mov']);
/** Actions whose reply carries a file worth keeping. */
const MEDIA_ACTIONS: Readonly<Record<string, MediaKind>> = {
  screenshot: 'screenshot',
  'screen-record': 'recording',
  'screen-record-stop': 'recording',
};

export const DEFAULT_MEDIA_POLICY: MediaPolicy = { maxAgeDays: MEDIA_MAX_AGE_DAYS, maxBytes: MEDIA_MAX_BYTES, maxItems: MEDIA_MAX_ITEMS };

/** An item as stored: the public fields minus `url`, plus the file name inside the media folder. */
interface StoredItem extends Omit<MediaItem, 'url'> {
  file: string;
}

export interface MediaLibraryDeps {
  /** `<dataDir>/media`. */
  dir: string;
  /** Where drivers save their files: only files directly inside it are taken. */
  tempDir: string;
  hub: Pick<Hub, 'getDevice' | 'pushSystemLog'>;
  logger: Logger;
  policy?: Partial<MediaPolicy>;
  now?: () => number;
  /** Hourly limit check (tests: 0 = none). */
  enforceIntervalMs?: number;
}

export function isMediaId(id: string): boolean {
  return MEDIA_ID.test(id);
}

/** "0:42", "1:05:09". */
export function clockText(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** A stored item read back from index.json, or undefined when it is not one this module wrote. */
function readStored(v: unknown): StoredItem | undefined {
  if (!isPlainObject(v)) return undefined;
  const { id, kind, deviceId, ts, bytes, file, fileName } = v;
  if (typeof id !== 'string' || !isMediaId(id)) return undefined;
  if (kind !== 'screenshot' && kind !== 'recording') return undefined;
  if (typeof deviceId !== 'string' || !deviceId || typeof file !== 'string' || typeof fileName !== 'string') return undefined;
  if (path.basename(file) !== file || !file.startsWith(`${id}.`) || !EXTENSIONS.has(path.extname(file).toLowerCase())) return undefined;
  const t = finiteNumber(ts);
  const b = finiteNumber(bytes);
  if (t === undefined || b === undefined) return undefined;
  const out: StoredItem = { id, kind, deviceId, ts: t, bytes: b, file, fileName: fileSafe(fileName, 160) };
  if (typeof v.deviceName === 'string') out.deviceName = v.deviceName.slice(0, 200);
  if (v.platform === 'android' || v.platform === 'ios' || v.platform === 'other') out.platform = v.platform;
  for (const k of ['endTs', 'durationSec', 'width', 'height', 'logId'] as const) {
    const n = finiteNumber(v[k]);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

export class MediaLibrary {
  private items: StoredItem[] = [];
  /** Temp file → item id: the start and the stop reply of one recording carry the same file. */
  private readonly bySource = new Map<string, string>();
  private readonly policy: MediaPolicy;
  private readonly now: () => number;
  private readonly dir: string;
  private readonly tempDir: string;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private disposed = false;
  readonly ready: Promise<void>;

  constructor(private readonly deps: MediaLibraryDeps) {
    this.dir = path.resolve(deps.dir);
    this.tempDir = path.resolve(deps.tempDir);
    this.policy = { ...DEFAULT_MEDIA_POLICY, ...deps.policy };
    this.now = deps.now ?? Date.now;
    this.ready = this.serial(() => this.load()).catch((err) => deps.logger.warn(`media library could not load: ${errorMessage(err)}`));
    const every = deps.enforceIntervalMs ?? ENFORCE_INTERVAL_MS;
    if (every > 0) {
      this.timer = setInterval(() => void this.serial(() => this.enforce()).catch(() => undefined), every);
      this.timer.unref?.();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Writes and removals one after the other (index.json stays consistent). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private publicItem(s: StoredItem): MediaItem {
    const { file: _file, ...rest } = s;
    return { ...rest, url: `/api/media/${encodeURIComponent(s.id)}` };
  }

  list(deviceId?: string): MediaList {
    const all = this.items;
    const items = (deviceId ? all.filter((i) => i.deviceId === deviceId) : all).map((i) => this.publicItem(i));
    return { items, policy: { ...this.policy }, usedBytes: all.reduce((n, i) => n + i.bytes, 0), total: all.length };
  }

  get(id: string): MediaItem | undefined {
    const s = this.items.find((i) => i.id === id);
    return s ? this.publicItem(s) : undefined;
  }

  /** Absolute path of an item's file (inside the media folder), or undefined. */
  filePath(id: string): string | undefined {
    const s = this.items.find((i) => i.id === id);
    return s ? path.join(this.dir, s.file) : undefined;
  }

  /**
   * Keep the file of a successful media action and add `data.media` to the result; any other result comes back
   * unchanged. Never throws: a file that cannot be kept leaves the reply as the driver made it.
   */
  async ingest(deviceId: string, action: string, result: DeviceActionResult): Promise<DeviceActionResult> {
    const kind = MEDIA_ACTIONS[action];
    if (!kind || this.disposed || !result || result.ok !== true || !isPlainObject(result.data)) return result;
    const data = result.data;
    if (typeof data.file !== 'string' || !path.isAbsolute(data.file)) return result;
    const source = path.resolve(data.file);
    if (path.dirname(source) !== this.tempDir) return result;
    try {
      await this.ready;
      const item = await this.serial(() => this.add(deviceId, kind, source, data));
      return item ? { ...result, data: { ...data, media: item } } : result;
    } catch (err) {
      this.deps.logger.warn(`media library: could not keep ${path.basename(source)}: ${errorMessage(err)}`);
      return result;
    }
  }

  private async add(deviceId: string, kind: MediaKind, source: string, data: Record<string, unknown>): Promise<MediaItem | undefined> {
    const known = this.bySource.get(source);
    if (known) return this.get(known);
    const ext = path.extname(source).toLowerCase();
    if (!EXTENSIONS.has(ext)) return undefined;
    const st = await fsp.stat(source).catch(() => undefined);
    if (!st?.isFile() || st.size === 0) return undefined;
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const now = this.now();
    const id = `m-${now.toString(36)}-${randomBytes(3).toString('hex')}`;
    const file = `${id}${ext}`;
    const target = path.join(this.dir, file);
    // Same disk as the temp folder: a hard link costs nothing; another disk (temp fallback): a copy.
    await fsp.link(source, target).catch(() => fsp.copyFile(source, target));
    const device = this.deps.hub.getDevice(deviceId);
    const label = device?.name || deviceId;
    const durationSec = finiteNumber(data.durationSec);
    const ts = kind === 'recording' && durationSec !== undefined ? now - durationSec * 1000 : now;
    const item: StoredItem = {
      id,
      kind,
      deviceId,
      ts,
      bytes: st.size,
      file,
      fileName: `${kind === 'screenshot' ? 'screenshot' : 'recording'}-${fileSafe(label)}-${stamp(ts)}${ext}`,
    };
    if (device?.name) item.deviceName = device.name;
    if (device?.platform) item.platform = device.platform;
    if (kind === 'recording') {
      item.endTs = now;
      if (durationSec !== undefined) item.durationSec = durationSec;
    }
    const width = finiteNumber(data.width);
    const height = finiteNumber(data.height);
    if (width && height) {
      item.width = width;
      item.height = height;
    }
    try {
      const ref: MediaRef = { id, kind };
      const line =
        kind === 'screenshot'
          ? this.deps.hub.pushSystemLog(deviceId, {
              message: `Screenshot · ${label}`,
              level: 'info',
              kind: 'marker',
              code: 'media.screenshot',
              params: { device: label },
              data: { media: ref },
            })
          : this.deps.hub.pushSystemLog(deviceId, {
              message: `Screen recording · ${label} · ${clockText(durationSec ?? 0)}`,
              level: 'info',
              kind: 'marker',
              code: 'media.recording',
              params: { device: label, duration: clockText(durationSec ?? 0) },
              data: { media: ref },
            });
      if (line && typeof line.id === 'number') item.logId = line.id;
    } catch (err) {
      this.deps.logger.debug(`media marker failed: ${errorMessage(err)}`);
    }
    this.items.unshift(item);
    this.bySource.set(source, id);
    await this.enforce(id);
    await this.save();
    return this.get(id);
  }

  /** Remove items by id; returns how many were removed. */
  remove(ids: readonly string[]): Promise<number> {
    return this.serial(async () => {
      const set = new Set(ids);
      const gone = this.items.filter((i) => set.has(i.id));
      if (!gone.length) return 0;
      await this.drop(gone);
      await this.save();
      return gone.length;
    });
  }

  /** Every item of one device. */
  removeDevice(deviceId: string): Promise<number> {
    return this.remove(this.items.filter((i) => i.deviceId === deviceId).map((i) => i.id));
  }

  private async drop(gone: readonly StoredItem[]): Promise<void> {
    const ids = new Set(gone.map((g) => g.id));
    this.items = this.items.filter((i) => !ids.has(i.id));
    for (const [src, id] of this.bySource) if (ids.has(id)) this.bySource.delete(src);
    for (const g of gone) await fsp.rm(path.join(this.dir, g.file), { force: true }).catch(() => undefined);
  }

  /**
   * Apply the limits: too old first, then the oldest while over the count or the size. `keep` (the item just
   * added) is never the one removed for the count or the size. Returns how many went.
   */
  async enforce(keep?: string): Promise<number> {
    const now = this.now();
    const maxAge = this.policy.maxAgeDays * DAY_MS;
    const gone: StoredItem[] = this.items.filter((i) => i.id !== keep && now - (i.endTs ?? i.ts) > maxAge);
    const left = this.items.filter((i) => !gone.includes(i)).sort((a, b) => b.ts - a.ts);
    let bytes = left.reduce((n, i) => n + i.bytes, 0);
    while (left.length > 1 && (left.length > this.policy.maxItems || bytes > this.policy.maxBytes)) {
      let idx = left.length - 1;
      while (idx >= 0 && left[idx]!.id === keep) idx--;
      if (idx < 0) break;
      const [old] = left.splice(idx, 1);
      bytes -= old!.bytes;
      gone.push(old!);
    }
    if (!gone.length) return 0;
    await this.drop(gone);
    if (keep === undefined) await this.save();
    this.deps.logger.debug(`media library: removed ${gone.length} item(s) past the limits`);
    return gone.length;
  }

  private async save(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(path.join(this.dir, MEDIA_INDEX_FILE), JSON.stringify({ version: INDEX_VERSION, items: this.items }, null, 1));
  }

  private async load(): Promise<void> {
    let raw: string | undefined;
    try {
      raw = await fsp.readFile(path.join(this.dir, MEDIA_INDEX_FILE), 'utf8');
    } catch {
      raw = undefined;
    }
    const parsed: unknown = raw ? (() => { try { return JSON.parse(raw); } catch { return undefined; } })() : undefined;
    const list = isPlainObject(parsed) && Array.isArray(parsed.items) ? parsed.items : [];
    const items: StoredItem[] = [];
    const seen = new Set<string>();
    for (const v of list) {
      const s = readStored(v);
      if (!s || seen.has(s.id)) continue;
      const st = await statFile(path.join(this.dir, s.file));
      if (!st?.isFile()) continue; // deleted by hand: the item goes too
      seen.add(s.id);
      items.push({ ...s, bytes: st.size });
    }
    this.items = items.sort((a, b) => b.ts - a.ts);
    // Files no item names (a crash between the link and the index): removed.
    const names = await fsp.readdir(this.dir).catch(() => [] as string[]);
    const kept = new Set(this.items.map((i) => i.file));
    for (const name of names) {
      if (name === MEDIA_INDEX_FILE || kept.has(name)) continue;
      if (/^m-[0-9a-z]+-[0-9a-f]{6}\./.test(name) || /^\.index\.json\..*\.tmp$/.test(name)) {
        await fsp.rm(path.join(this.dir, name), { force: true }).catch(() => undefined);
      }
    }
    const removed = await this.enforce();
    if (!removed && raw !== undefined && items.length !== list.length) await this.save();
  }

  /* ───────────── HTTP ───────────── */

  /** Route group for createApiHandler's `modules`. */
  module(): { prefixes: readonly string[]; handle(req: IncomingMessage, res: ServerResponse, segs: string[], query: URLSearchParams): Promise<void> } {
    return { prefixes: ['media'], handle: (req, res, segs, query) => this.handle(req, res, segs, query) };
  }

  private async handle(req: IncomingMessage, res: ServerResponse, segs: string[], query: URLSearchParams): Promise<void> {
    await this.ready;
    const method = req.method ?? 'GET';
    if (segs.length === 1) {
      if (method === 'GET' || method === 'HEAD') return sendJson(res, 200, this.list(queryString(query, 'deviceId')));
      if (method === 'DELETE') {
        const deviceId = queryString(query, 'deviceId');
        if (!deviceId) throw new HttpError(400, 'deviceId is required', 'media.deviceRequired');
        return sendJson(res, 200, { removed: await this.removeDevice(deviceId) });
      }
      throw notAllowed('GET, HEAD, DELETE');
    }
    if (segs.length === 2) {
      const id = segs[1] ?? '';
      if (method === 'DELETE') {
        if (!isMediaId(id)) throw new HttpError(404, 'Media item not found', 'media.unknown');
        const removed = await this.remove([id]);
        if (!removed) throw new HttpError(404, 'Media item not found', 'media.unknown');
        return sendJson(res, 200, { removed });
      }
      if (method !== 'GET' && method !== 'HEAD') throw notAllowed('GET, HEAD, DELETE');
      return this.sendItem(req, res, id, query);
    }
    throw new HttpError(404, 'Not found', 'api.notFound');
  }

  private async sendItem(req: IncomingMessage, res: ServerResponse, id: string, query: URLSearchParams): Promise<void> {
    const item = isMediaId(id) ? this.items.find((i) => i.id === id) : undefined;
    if (!item) throw new HttpError(404, 'Media item not found', 'media.unknown');
    const filePath = path.join(this.dir, item.file);
    const stat = await statFile(filePath);
    // A symlink must not lead out of the media folder.
    const reals = stat?.isFile() ? await Promise.all([fsp.realpath(filePath), fsp.realpath(this.dir)]).catch(() => undefined) : undefined;
    if (!stat || !reals || !isInside(reals[1], reals[0]) || reals[0] === reals[1]) {
      throw new HttpError(404, 'The file of this item is gone', 'media.fileMissing');
    }
    const headers: Record<string, string> = {};
    if (isTruthyParam(query, 'download')) headers['Content-Disposition'] = contentDisposition(item.fileName);
    sendFile(req, res, reals[0], stat, { cacheControl: 'no-cache', sandboxActive: true, headers });
  }
}

function notAllowed(allow: string): HttpError & { allow: string } {
  return Object.assign(new HttpError(405, 'Method not allowed', 'method.notAllowed'), { allow });
}
