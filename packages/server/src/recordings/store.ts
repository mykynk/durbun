/**
 * On-disk store of the session recorder (SPEC §13): one folder per recording, append-only compressed chunks.
 *
 *   <dataDir>/recordings/                         0700
 *     20261115T184012Z-a1b2/                      0700, one recording = one run of the server (or until it is turned off)
 *       meta.json                                 0600, RecordingMeta, replaced atomically (temp file + rename)
 *       chunk-000001.ndjson.gz                    0600, append-only: one gzip member per flush
 *       chunk-000002.ndjson.gz                    …the next one once a chunk holds CHUNK_BYTES
 *
 * Why this layout:
 * - Append-only gzip members: every flush (about once a second) compresses its lines on the libuv thread pool
 *   (zlib.gzip) and appends one complete member with a single write. A hard kill loses only what was not appended
 *   yet; a member cut short by the kill is the only damaged part. Concatenated members are a valid gzip file
 *   (`gunzip -c chunk-*.gz` reads a recording), and gzip shrinks log text about ten times.
 * - The reader splits a chunk at the member header this writer always emits and decompresses each member on its
 *   own: a torn or corrupt member loses its own lines, never the members around it. Lines are complete per member;
 *   a torn member's last partial line is dropped.
 * - Chunks: the per-recording limit removes whole old chunks, and every chunk starts with the devices, app sessions
 *   and device apps known when it was opened, so any run of newest chunks reads on its own.
 * - meta.json is small and rewritten every few seconds: the list never opens chunks. A recording whose meta has no
 *   `endedAt` when the server starts was interrupted (the data folder lock allows one server per folder).
 * - Each line is a record `{"k":…}` holding the protocol's own objects (LogEntry, NetworkDetail, MetricSample,
 *   DeviceInfo, AppSession, DeviceApp): reading back builds a SessionExport, the format import already understands.
 *   Records of the same request / device / app replace older ones (the newest state wins).
 */
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import {
  RECORDING_DEFAULTS,
  type AppSession,
  type DeviceApp,
  type DeviceInfo,
  type LogEntry,
  type MetricSample,
  type NetworkDetail,
  type SessionExport,
  type SessionRecording,
} from '@durbun/protocol';
import { writeFileAtomic } from '../config';

const gzipAsync = promisify(zlib.gzip);

export const RECORDINGS_DIR_NAME = 'recordings';
export const RECORDING_FORMAT = 'durbun-recording';
export const META_FILE = 'meta.json';
/** A chunk is closed once this much (compressed) was appended to it. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Folder names the store creates and the routes accept. */
export const RECORDING_ID = /^\d{8}T\d{6}Z-[0-9a-f]{4}$/;
const CHUNK_FILE = /^chunk-(\d{6})\.ndjson\.gz$/;
/** At most this many devices / apps are named in a recording's meta. */
const META_LIST_MAX = 20;
/** The 10-byte member header zlib writes (no name, no mtime): the reader splits chunks there. */
const GZIP_HEADER = zlib.gzipSync(Buffer.alloc(0)).subarray(0, 10);

/** One line of a chunk. */
export type RecordLine =
  | { k: 'log'; v: LogEntry }
  | { k: 'net'; v: NetworkDetail }
  | { k: 'metric'; v: MetricSample }
  | { k: 'device'; v: DeviceInfo }
  | { k: 'app'; v: AppSession }
  | { k: 'deviceApp'; v: DeviceApp }
  /** Records that arrived while writing was paused and are missing. */
  | { k: 'gap'; n: number; ts: number };

export interface RecordingMeta {
  format: typeof RECORDING_FORMAT;
  version: 1;
  id: string;
  startedAt: number;
  lastWriteAt: number;
  endedAt?: number;
  interrupted?: boolean;
  serverVersion?: string;
  counts: SessionRecording['counts'];
  devices: SessionRecording['devices'];
  apps: SessionRecording['apps'];
  trimmed?: boolean;
  gaps?: number;
}

export interface RecordingLimits {
  maxDays: number;
  maxBytes: number;
  maxRecordingBytes: number;
}

/** The limits from the settings (MB / days; absent = defaults). One recording never takes more than half of the total. */
export function recordingLimits(settings: { recordingsMaxDays?: number; recordingsMaxMB?: number }): RecordingLimits {
  const maxDays = settings.recordingsMaxDays ?? RECORDING_DEFAULTS.maxDays;
  const maxBytes = (settings.recordingsMaxMB ?? RECORDING_DEFAULTS.maxMB) * MB;
  return { maxDays, maxBytes, maxRecordingBytes: Math.min(RECORDING_DEFAULTS.recordingMB * MB, Math.floor(maxBytes / 2)) };
}

/** "20261115T184012Z-a1b2" for a start time. */
export function newRecordingId(startedAt: number): string {
  const iso = new Date(startedAt).toISOString(); // 2026-11-15T18:40:12.345Z
  return `${iso.slice(0, 10).replace(/-/g, '')}T${iso.slice(11, 19).replace(/:/g, '')}Z-${randomBytes(2).toString('hex')}`;
}

export function chunkName(n: number): string {
  return `chunk-${String(n).padStart(6, '0')}.ndjson.gz`;
}

async function chunkFiles(dir: string): Promise<{ name: string; n: number }[]> {
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const out: { name: string; n: number }[] = [];
  for (const name of names) {
    const m = CHUNK_FILE.exec(name);
    if (m) out.push({ name, n: Number(m[1]) });
  }
  return out.sort((a, b) => a.n - b.n);
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
    const st = await fsp.stat(path.join(dir, name)).catch(() => undefined);
    if (st?.isFile()) total += st.size;
  }
  return total;
}

/* ────────────────────────────── writer ────────────────────────────── */

/** What the writer needs of an open chunk file (a FileHandle; tests pass one that fails). */
export interface ChunkHandle {
  write(data: Buffer): Promise<unknown>;
  datasync(): Promise<void>;
  close(): Promise<void>;
}

export interface RecordingWriterOptions {
  /** `<dataDir>/recordings`. */
  root: string;
  meta: RecordingMeta;
  /** Records every new chunk starts with (devices, app sessions, device apps known now). */
  header(): RecordLine[];
  maxRecordingBytes: number;
  chunkBytes?: number;
  /** Tests: opens a chunk for appending (default: fs, mode 0600). */
  openChunk?: (file: string) => Promise<ChunkHandle>;
}

const openForAppend = (file: string): Promise<ChunkHandle> => fsp.open(file, 'a', 0o600);

/**
 * Appends to one recording. Calls are serialized by the caller (the recorder has one flush in flight). Every
 * method may throw an fs error (ENOSPC, EACCES…); the recorder pauses on it.
 */
export class RecordingWriter {
  readonly dir: string;
  readonly meta: RecordingMeta;
  private chunkNo = 0;
  private handle: ChunkHandle | undefined;
  private chunkSize = 0;
  private created = false;
  private bytes = 0;
  private readonly chunkLimit: number;

  constructor(private readonly opts: RecordingWriterOptions) {
    this.meta = opts.meta;
    this.dir = path.join(opts.root, opts.meta.id);
    this.chunkLimit = opts.chunkBytes ?? CHUNK_BYTES;
  }

  /** Bytes of the chunks on disk. */
  get size(): number {
    return this.bytes;
  }

  /** Append NDJSON text (complete lines) as one gzip member; a new chunk starts with the header records. */
  async append(text: string): Promise<void> {
    if (!text) return;
    await this.ensureFolder();
    let body = text;
    if (!this.handle) {
      this.chunkNo++;
      this.chunkSize = 0;
      this.handle = await (this.opts.openChunk ?? openForAppend)(path.join(this.dir, chunkName(this.chunkNo)));
      body = serializeLines(this.opts.header()) + text;
    }
    const member = await gzipAsync(Buffer.from(body, 'utf8'));
    await this.handle.write(member);
    this.chunkSize += member.length;
    this.bytes += member.length;
    if (this.chunkSize >= this.chunkLimit) {
      await this.closeChunk(true);
      await this.trim();
    }
  }

  /** Write meta.json now (atomic). */
  async writeMeta(): Promise<void> {
    await this.ensureFolder();
    await writeFileAtomic(path.join(this.dir, META_FILE), JSON.stringify(this.meta), 0o600);
  }

  /** Close the chunk and write the final meta (endedAt). Never throws for a folder that was never created. */
  async close(endedAt: number): Promise<void> {
    await this.closeChunk(true);
    if (!this.created) return;
    this.meta.endedAt = endedAt;
    await this.writeMeta();
  }

  /** Make sure data reached the disk (called every few seconds and on rotation). */
  async sync(): Promise<void> {
    await this.handle?.datasync().catch(() => {});
  }

  private async ensureFolder(): Promise<void> {
    if (this.created) return;
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.opts.root, 0o700).catch(() => {});
    this.created = true;
    await writeFileAtomic(path.join(this.dir, META_FILE), JSON.stringify(this.meta), 0o600);
  }

  private async closeChunk(sync: boolean): Promise<void> {
    const h = this.handle;
    this.handle = undefined;
    if (!h) return;
    if (sync) await h.datasync().catch(() => {});
    await h.close().catch(() => {});
  }

  /** Past the per-recording limit: remove whole chunks, oldest first (never the one being written). */
  private async trim(): Promise<void> {
    if (this.bytes <= this.opts.maxRecordingBytes) return;
    const files = await chunkFiles(this.dir);
    let total = 0;
    const sizes = new Map<string, number>();
    for (const f of files) {
      const st = await fsp.stat(path.join(this.dir, f.name)).catch(() => undefined);
      sizes.set(f.name, st?.size ?? 0);
      total += st?.size ?? 0;
    }
    for (const f of files) {
      if (total <= this.opts.maxRecordingBytes || f.n >= this.chunkNo) break;
      await fsp.rm(path.join(this.dir, f.name), { force: true });
      total -= sizes.get(f.name) ?? 0;
      this.meta.trimmed = true;
    }
    this.bytes = total;
  }
}

export function serializeLines(lines: RecordLine[]): string {
  let out = '';
  for (const line of lines) {
    const json = safeStringify(line);
    if (json) out += json + '\n';
  }
  return out;
}

/** JSON of one record; a record that cannot be serialized (cycles, BigInt in `data`) is written without `data`. */
export function safeStringify(line: RecordLine): string | undefined {
  try {
    return JSON.stringify(line);
  } catch {
    if (line.k === 'log') {
      try {
        const { data: _data, ...rest } = line.v;
        return JSON.stringify({ k: 'log', v: { ...rest, data: '[unserializable data]' } });
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/* ────────────────────────────── reader ────────────────────────────── */

/** Split a chunk at member headers and decompress each member alone. `damaged` counts members that failed. */
export function decodeChunk(buf: Buffer): { lines: string[]; damaged: number } {
  const starts: number[] = [];
  for (let at = buf.indexOf(GZIP_HEADER, 0); at >= 0; at = buf.indexOf(GZIP_HEADER, at + GZIP_HEADER.length)) starts.push(at);
  const lines: string[] = [];
  let damaged = starts.length === 0 && buf.length > 0 ? 1 : 0;
  for (let i = 0; i < starts.length; i++) {
    const member = buf.subarray(starts[i], i + 1 < starts.length ? starts[i + 1] : buf.length);
    let text: string;
    try {
      text = zlib.gunzipSync(member).toString('utf8');
    } catch {
      // Cut short (a hard kill during the write) or corrupt: keep the complete lines it still gives.
      damaged++;
      try {
        text = zlib.gunzipSync(member, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8');
      } catch {
        continue;
      }
    }
    const end = text.lastIndexOf('\n');
    if (end < 0) continue;
    for (const line of text.slice(0, end).split('\n')) if (line) lines.push(line);
  }
  return { lines, damaged };
}

export interface ReadLimits {
  maxLogs: number;
  maxRequests: number;
  /** Request / response bodies kept (bytes); older requests past it lose their bodies (`bodyEvicted`). */
  maxBodyBytes: number;
  maxMetrics?: number;
}

export interface ReadResult {
  data: SessionExport;
  loaded: { logs: number; requests: number };
  /** Lines / requests of the recording left out (older than what the limits hold). */
  left: { logs: number; requests: number };
  /** Members and lines that could not be read. */
  damaged: number;
}

function bodyBytes(d: NetworkDetail): number {
  return (d.requestBody?.data.length ?? 0) + (d.responseBody?.data.length ?? 0);
}

/**
 * Read a recording back as a SessionExport, newest first: the newest `maxLogs` lines, the newest state of the newest
 * `maxRequests` requests (bodies within `maxBodyBytes`), and every device / app / device app it names. Older chunks
 * are not opened once every list is full, so a large recording opens as fast as a small one.
 */
export async function readRecording(root: string, id: string, limits: ReadLimits, serverVersion = 'unknown'): Promise<ReadResult> {
  const dir = path.join(root, id);
  const meta = await readMeta(dir);
  const files = await chunkFiles(dir);
  if (!meta && files.length === 0) throw Object.assign(new Error(`Recording ${id} not found`), { code: 'ENOENT' });
  const maxMetrics = limits.maxMetrics ?? 200_000;
  const logs: LogEntry[] = [];
  const network: NetworkDetail[] = [];
  const metrics: MetricSample[] = [];
  const seenNet = new Set<string>();
  const devices = new Map<string, DeviceInfo>();
  const apps = new Map<string, AppSession>();
  const deviceApps = new Map<string, DeviceApp>();
  let bodies = 0;
  let damaged = 0;
  let leftLogs = 0;
  let leftRequests = 0;
  let readAll = true;

  for (let c = files.length - 1; c >= 0; c--) {
    if (logs.length >= limits.maxLogs && network.length >= limits.maxRequests && metrics.length >= maxMetrics) {
      readAll = false;
      break;
    }
    let buf: Buffer;
    try {
      buf = await fsp.readFile(path.join(dir, files[c]!.name));
    } catch {
      damaged++;
      continue;
    }
    const chunk = decodeChunk(buf);
    damaged += chunk.damaged;
    for (let i = chunk.lines.length - 1; i >= 0; i--) {
      let rec: RecordLine;
      try {
        rec = JSON.parse(chunk.lines[i]!) as RecordLine;
      } catch {
        damaged++;
        continue;
      }
      if (!rec || typeof rec !== 'object') continue;
      switch (rec.k) {
        case 'log':
          if (logs.length < limits.maxLogs) logs.push(rec.v);
          else leftLogs++;
          break;
        case 'net': {
          const d = rec.v;
          if (!d || typeof d.id !== 'string' || seenNet.has(d.id)) break;
          seenNet.add(d.id);
          if (network.length >= limits.maxRequests) {
            leftRequests++;
            break;
          }
          const size = bodyBytes(d);
          if (size > 0 && bodies + size > limits.maxBodyBytes) {
            const { requestBody: _rq, responseBody: _rs, ...rest } = d;
            network.push({ ...rest, bodyEvicted: true });
          } else {
            bodies += size;
            network.push(d);
          }
          break;
        }
        case 'metric':
          if (metrics.length < maxMetrics) metrics.push(rec.v);
          break;
        case 'device':
          if (rec.v && typeof rec.v.id === 'string' && !devices.has(rec.v.id)) devices.set(rec.v.id, rec.v);
          break;
        case 'app':
          if (rec.v && typeof rec.v.id === 'string' && !apps.has(rec.v.id)) apps.set(rec.v.id, rec.v);
          break;
        case 'deviceApp': {
          const key = rec.v && `${rec.v.deviceId}|${rec.v.id}`;
          if (key && !deviceApps.has(key)) deviceApps.set(key, rec.v);
          break;
        }
        default:
          break;
      }
    }
  }
  if (!readAll && meta) {
    // Older chunks were not opened: what they hold is known from the counts in meta.json.
    leftLogs = Math.max(leftLogs, meta.counts.logs - logs.length);
    leftRequests = Math.max(leftRequests, meta.counts.requests - network.length);
  }
  logs.reverse();
  network.reverse();
  metrics.reverse();
  const data: SessionExport = {
    format: 'durbun-session',
    version: 1,
    exportedAt: meta?.lastWriteAt ?? Date.now(),
    server: { version: meta?.serverVersion ?? serverVersion },
    devices: [...devices.values()],
    apps: [...apps.values()],
    logs,
    network,
    metrics,
  };
  if (deviceApps.size > 0) data.deviceApps = [...deviceApps.values()];
  return { data, loaded: { logs: logs.length, requests: network.length }, left: { logs: leftLogs, requests: leftRequests }, damaged };
}

/* ────────────────────────────── folder: list, sweep, delete ────────────────────────────── */

export async function readMeta(dir: string): Promise<RecordingMeta | undefined> {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(dir, META_FILE), 'utf8')) as Partial<RecordingMeta>;
    if (raw?.format !== RECORDING_FORMAT || typeof raw.id !== 'string' || typeof raw.startedAt !== 'number') return undefined;
    return {
      format: RECORDING_FORMAT,
      version: 1,
      id: raw.id,
      startedAt: raw.startedAt,
      lastWriteAt: typeof raw.lastWriteAt === 'number' ? raw.lastWriteAt : raw.startedAt,
      ...(typeof raw.endedAt === 'number' ? { endedAt: raw.endedAt } : {}),
      ...(raw.interrupted ? { interrupted: true } : {}),
      ...(typeof raw.serverVersion === 'string' ? { serverVersion: raw.serverVersion } : {}),
      counts: {
        logs: num(raw.counts?.logs),
        requests: num(raw.counts?.requests),
        errors: num(raw.counts?.errors),
        crashes: num(raw.counts?.crashes),
      },
      devices: Array.isArray(raw.devices) ? raw.devices.slice(0, META_LIST_MAX) : [],
      apps: Array.isArray(raw.apps) ? raw.apps.slice(0, META_LIST_MAX) : [],
      ...(raw.trimmed ? { trimmed: true } : {}),
      ...(num(raw.gaps) > 0 ? { gaps: num(raw.gaps) } : {}),
    };
  } catch {
    return undefined;
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** A recording's summary from its folder; `liveId` is the one this run writes. */
export async function summarize(root: string, id: string, liveId?: string): Promise<SessionRecording | undefined> {
  const dir = path.join(root, id);
  const st = await fsp.stat(dir).catch(() => undefined);
  if (!st?.isDirectory()) return undefined;
  const meta = await readMeta(dir);
  const bytes = await folderBytes(dir);
  if (!meta) {
    // No readable meta (a crash right after the folder was made): still listed, so it can be opened or deleted.
    const files = await chunkFiles(dir);
    if (files.length === 0) return undefined;
    return {
      id,
      startedAt: st.birthtimeMs || st.mtimeMs,
      lastWriteAt: st.mtimeMs,
      endedAt: st.mtimeMs,
      state: id === liveId ? 'recording' : 'interrupted',
      bytes,
      counts: { logs: 0, requests: 0, errors: 0, crashes: 0 },
      devices: [],
      apps: [],
    };
  }
  const state: SessionRecording['state'] = id === liveId ? 'recording' : meta.endedAt === undefined || meta.interrupted ? 'interrupted' : 'ended';
  const out: SessionRecording = {
    id,
    startedAt: meta.startedAt,
    lastWriteAt: meta.lastWriteAt,
    state,
    bytes,
    counts: meta.counts,
    devices: meta.devices,
    apps: meta.apps,
  };
  if (state !== 'recording') out.endedAt = meta.endedAt ?? meta.lastWriteAt;
  if (meta.trimmed) out.trimmed = true;
  if (meta.gaps) out.gaps = meta.gaps;
  if (meta.serverVersion) out.serverVersion = meta.serverVersion;
  return out;
}

/** Every recording, newest first. */
export async function listRecordings(root: string, liveId?: string): Promise<SessionRecording[]> {
  const names = await fsp.readdir(root).catch(() => [] as string[]);
  const out: SessionRecording[] = [];
  for (const name of names) {
    if (!RECORDING_ID.test(name)) continue;
    const s = await summarize(root, name, liveId);
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1));
}

/**
 * At start: recordings left without `endedAt` belong to a run that stopped without closing them. They get their last
 * write as end and `interrupted`, so the list says so. Returns their ids.
 */
export async function markInterrupted(root: string, skip?: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await fsp.readdir(root).catch(() => [] as string[])) {
    if (!RECORDING_ID.test(name) || name === skip) continue;
    const dir = path.join(root, name);
    const meta = await readMeta(dir);
    if (!meta || meta.endedAt !== undefined) continue;
    const files = await chunkFiles(dir);
    let last = meta.lastWriteAt;
    for (const f of files) {
      const st = await fsp.stat(path.join(dir, f.name)).catch(() => undefined);
      if (st && st.mtimeMs > last) last = st.mtimeMs;
    }
    meta.lastWriteAt = last;
    meta.endedAt = last;
    meta.interrupted = true;
    await writeFileAtomic(path.join(dir, META_FILE), JSON.stringify(meta), 0o600).catch(() => {});
    out.push(name);
  }
  return out;
}

export async function deleteRecording(root: string, id: string): Promise<boolean> {
  if (!RECORDING_ID.test(id)) return false;
  const dir = path.join(root, id);
  const st = await fsp.stat(dir).catch(() => undefined);
  if (!st?.isDirectory()) return false;
  await fsp.rm(dir, { recursive: true, force: true });
  return true;
}

/**
 * Enforce the limits: recordings whose last write is older than `maxDays` go, then the oldest while all of them
 * take more than `maxBytes`. `keep` (the recording being written) is never removed. Leftover temp files of an
 * interrupted meta write go too. Returns the removed ids.
 */
export async function sweepRecordings(root: string, limits: RecordingLimits, keep: ReadonlySet<string>, now = Date.now()): Promise<string[]> {
  const names = await fsp.readdir(root).catch(() => [] as string[]);
  const items: { id: string; at: number; bytes: number }[] = [];
  for (const name of names) {
    const p = path.join(root, name);
    if (!RECORDING_ID.test(name)) continue;
    // Stray temp files of an atomic meta write.
    for (const inner of await fsp.readdir(p).catch(() => [] as string[])) {
      if (inner.startsWith(`.${META_FILE}.`) && inner.endsWith('.tmp')) await fsp.rm(path.join(p, inner), { force: true }).catch(() => {});
    }
    const meta = await readMeta(p);
    const st = await fsp.stat(p).catch(() => undefined);
    items.push({ id: name, at: meta?.lastWriteAt ?? st?.mtimeMs ?? now, bytes: await folderBytes(p) });
  }
  const removed: string[] = [];
  const cutoff = now - limits.maxDays * DAY_MS;
  let total = items.reduce((sum, i) => sum + i.bytes, 0);
  items.sort((a, b) => a.at - b.at);
  for (const item of items) {
    if (keep.has(item.id)) continue;
    if (item.at >= cutoff && total <= limits.maxBytes) continue;
    await fsp.rm(path.join(root, item.id), { recursive: true, force: true }).catch(() => {});
    total -= item.bytes;
    removed.push(item.id);
  }
  return removed;
}

/** Bytes of every recording together. */
export async function recordingsBytes(root: string): Promise<number> {
  let total = 0;
  for (const name of await fsp.readdir(root).catch(() => [] as string[])) {
    if (RECORDING_ID.test(name)) total += await folderBytes(path.join(root, name));
  }
  return total;
}
