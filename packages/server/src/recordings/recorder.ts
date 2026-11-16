/**
 * The session recorder (SPEC §13): writes what this run captures to `<dataDir>/recordings/<id>/` (store.ts) so it
 * can be opened again after Dürbün quit or crashed.
 *
 * Never in the way of capture: it listens to the hub's batched changes (every ~100 ms) and only keeps references
 * there; a timer (about once a second) serializes them, compression runs on the thread pool and one write appends
 * the result. At most one write is in flight; what arrives meanwhile waits in a bounded queue. When the queue is
 * full (a disk slower than the capture) or a write fails (disk full, no permission), recording pauses: new data is
 * counted as a gap, not kept, the live data is untouched and the reason is said once as a system line
 * (`recorder.*`) and in the status (GET /api/recordings). Writing is tried again after RETRY_MS.
 *
 * What is recorded: every device's data except imported recordings (`import:`) and the demo (`demo:`), plus global
 * markers and requests replayed from the desktop. A run that captures nothing but Dürbün's own lines leaves nothing
 * on disk. "Clear" in the UI does not touch the recording: it is the record of the session.
 */
import { promises as fsp } from 'node:fs';
import {
  levelRank,
  type AppSession,
  type DeviceApp,
  type DeviceInfo,
  type I18nParams,
  type LogEntry,
  type NetworkDetail,
  type NetworkEntry,
  type RecorderPause,
  type RecorderStatus,
  type ServerSettings,
  type SessionRecording,
  type SessionRecordingList,
  type StreamMessage,
} from '@durbun/protocol';
import type { Hub, HubChange, Logger } from '../types';
import { errorMessage } from '../http/util';
import {
  deleteRecording,
  listRecordings,
  markInterrupted,
  newRecordingId,
  RECORDING_FORMAT,
  recordingLimits,
  recordingsBytes,
  RecordingWriter,
  serializeLines,
  sweepRecordings,
  type RecordingMeta,
  type RecordingWriterOptions,
  type RecordLine,
} from './store';

export const FLUSH_INTERVAL_MS = 1_000;
export const META_INTERVAL_MS = 5_000;
export const SWEEP_INTERVAL_MS = 10 * 60_000;
export const RETRY_MS = 30_000;
/** Queue bounds between two writes (records / estimated bytes). */
export const MAX_PENDING_RECORDS = 100_000;
export const MAX_PENDING_BYTES = 48 * 1024 * 1024;
/** Lines kept while nothing but Dürbün's own lines arrived (they open the recording once something real comes). */
const MAX_WAITING_RECORDS = 2_000;
/** Below this much free disk space recording pauses; it goes on above RESUME_FREE_BYTES. */
export const MIN_FREE_BYTES = 1024 * 1024 * 1024;
const RESUME_FREE_FACTOR = 1.5;
const FREE_CHECK_INTERVAL_MS = 30_000;
/** A pending request / open stream is written as it is after this long (a crash then keeps it). */
const OPEN_SNAPSHOT_MS = 30_000;
const DEVICE_APPS_INTERVAL_MS = 30_000;
const META_LIST_MAX = 20;
/** A queue this long is written without waiting for the timer. */
const EARLY_FLUSH_RECORDS = 10_000;
/** Records serialized per gzip member (a few ms of main-thread work each). */
const SLICE_RECORDS = 2_000;
const ERROR_RANK = levelRank('error');

type HubPart = Pick<Hub, 'subscribe' | 'getDevices' | 'getDevice' | 'getApps' | 'getDeviceApps' | 'getNetworkDetail' | 'getStreamMessages' | 'pushSystemLog'>;

export interface RecorderOptions {
  /** `<dataDir>/recordings`. */
  root: string;
  hub: HubPart;
  settings(): ServerSettings;
  logger: Logger;
  version: string;
  now?: () => number;
  flushIntervalMs?: number;
  metaIntervalMs?: number;
  sweepIntervalMs?: number;
  retryMs?: number;
  maxPendingRecords?: number;
  maxPendingBytes?: number;
  chunkBytes?: number;
  /** Tests: the chunk file opener (fail on purpose). */
  openChunk?: RecordingWriterOptions['openChunk'];
  /** Free bytes on the recordings' disk (default fs.statfs); undefined = unknown. */
  freeBytes?: (dir: string) => Promise<number | undefined>;
  minFreeBytes?: number;
}

/** Device ids whose data is not recorded: imported recordings and the demo. */
export function isRecordedDevice(deviceId: string): boolean {
  return !deviceId.startsWith('import:') && !deviceId.startsWith('demo:');
}

async function statfsFree(dir: string): Promise<number | undefined> {
  try {
    const st = await fsp.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return undefined;
  }
}

/** Disk errors → the pause the user sees (code, params, English text). */
export function pauseFor(err: unknown, dir: string): Omit<RecorderPause, 'since'> {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const error = errorMessage(err);
  if (code === 'ENOSPC' || code === 'EDQUOT') return { code: 'recorder.diskFull', params: { dir }, message: `The disk is full: recording paused (${dir})` };
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return { code: 'recorder.noAccess', params: { dir, error }, message: `Recording paused: Dürbün cannot write to ${dir} (${error})` };
  }
  return { code: 'recorder.writeFailed', params: { error }, message: `Recording paused: writing failed (${error})` };
}

const roughBytes = (e: LogEntry): number => 160 + (e.message?.length ?? 0) + (e.data !== undefined ? 512 : 0);

interface NetState {
  entry: NetworkEntry;
  dirty: boolean;
  lastWriteAt: number;
}

export class SessionRecorder {
  private readonly now: () => number;
  private readonly startedAt: number;
  private enabled: boolean;
  private stopped = false;
  /** Turning recording off closes the recording; deleting waits for it (the closed one may go too). */
  private finishing: Promise<void> = Promise.resolve();
  private writer: RecordingWriter | undefined;
  private hasContent = false;
  private pending: RecordLine[] = [];
  private pendingBytes = 0;
  private peakPending = 0;
  private gaps = 0;
  /** Records missing from this run's recordings so far (diagnostics). */
  private missing = 0;
  private pause: RecorderPause | undefined;
  private retryAt = 0;
  private flushing: Promise<void> | undefined;
  private readonly net = new Map<string, NetState>();
  private readonly finalized = new Set<string>();
  private dirtyDeviceApps = new Map<string, DeviceApp>();
  private lastDeviceAppsAt = 0;
  private lastMetaAt = 0;
  private lastFreeCheck = 0;
  private counts = { logs: 0, requests: 0, errors: 0, crashes: 0 };
  private readonly seenDevices = new Set<string>();
  private readonly appList = new Map<string, SessionRecording['apps'][number]>();
  private timers: NodeJS.Timeout[] = [];
  private unsubscribe: (() => void) | undefined;
  private sweeping = false;
  private ready: Promise<void> = Promise.resolve();
  private usedBytes = 0;

  constructor(private readonly opts: RecorderOptions) {
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.enabled = opts.settings().recordSessions !== false;
  }

  /**
   * Listen to the hub right away (nothing captured from now on is missed), then mark recordings of earlier runs that
   * were not closed and sweep; the first write waits for that. Never throws.
   */
  start(): Promise<void> {
    if (this.unsubscribe || this.stopped) return this.ready;
    this.unsubscribe = this.opts.hub.subscribe((change) => {
      try {
        this.onChange(change);
      } catch (err) {
        this.opts.logger.warn(`recorder: ${errorMessage(err)}`);
      }
    });
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      t.unref();
      this.timers.push(t);
    };
    every(this.opts.flushIntervalMs ?? FLUSH_INTERVAL_MS, () => void this.flush());
    every(this.opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS, () => void this.sweep());
    this.ready = (async () => {
      try {
        const interrupted = await markInterrupted(this.opts.root);
        if (interrupted.length) this.opts.logger.info(`recordings of an earlier run that did not close: ${interrupted.join(', ')}`);
      } catch (err) {
        this.opts.logger.debug(`recordings: ${errorMessage(err)}`);
      }
      await this.sweep();
    })();
    return this.ready;
  }

  /** Settings changed: on / off, limits. Turning off closes the recording being written at once. */
  async applySettings(settings: ServerSettings): Promise<void> {
    const enabled = settings.recordSessions !== false;
    if (enabled !== this.enabled) {
      this.enabled = enabled;
      if (!enabled) {
        this.finishing = this.finish('off');
        await this.finishing;
      }
      else this.clearPause();
    }
    void this.sweep();
  }

  status(): RecorderStatus {
    const limits = recordingLimits(this.opts.settings());
    const state: RecorderStatus['state'] = !this.enabled ? 'off' : this.pause ? 'paused' : this.writer ? 'recording' : 'waiting';
    const out: RecorderStatus = {
      enabled: this.enabled,
      state,
      dir: this.opts.root,
      usedBytes: this.usedBytes,
      maxDays: limits.maxDays,
      maxBytes: limits.maxBytes,
      maxRecordingBytes: limits.maxRecordingBytes,
    };
    if (this.pause && this.enabled) out.paused = { ...this.pause };
    if (this.writer) out.current = this.writer.meta.id;
    return out;
  }

  /** Queue diagnostics (tests, the throughput check): records waiting now, the most that waited, missing so far. */
  queueStats(): { records: number; bytes: number; peakRecords: number; gaps: number } {
    return { records: this.pending.length, bytes: this.pendingBytes, peakRecords: this.peakPending, gaps: this.missing };
  }

  /** The recording being written (never swept, never opened as a view). */
  get currentId(): string | undefined {
    return this.writer?.meta.id;
  }

  async list(): Promise<SessionRecordingList> {
    await this.finishing;
    const live = this.currentId;
    if (this.writer) await this.writeMeta().catch(() => {});
    const recordings = await listRecordings(this.opts.root, live);
    this.usedBytes = recordings.reduce((sum, r) => sum + r.bytes, 0);
    const out: SessionRecordingList = { status: this.status(), recordings };
    const previous = recordings.find((r) => r.id !== live && r.startedAt < this.startedAt);
    if (previous) out.previous = previous.id;
    return out;
  }

  /** Delete one recording (not the one being written). */
  async delete(id: string): Promise<boolean> {
    if (id === this.currentId) return false;
    const removed = await deleteRecording(this.opts.root, id);
    this.usedBytes = await recordingsBytes(this.opts.root);
    return removed;
  }

  /** Delete every recording except the one being written. Returns the ids. */
  async deleteAll(): Promise<string[]> {
    await this.finishing;
    const out: string[] = [];
    for (const r of await listRecordings(this.opts.root, this.currentId)) {
      if (r.state !== 'recording' && (await deleteRecording(this.opts.root, r.id))) out.push(r.id);
    }
    this.usedBytes = await recordingsBytes(this.opts.root);
    return out;
  }

  /** Final flush and close (server stop). */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.unsubscribe?.();
    await this.finish('quit');
  }

  /** Wait for the write in flight, then write what is queued now (as the timer would). */
  async flushNow(): Promise<void> {
    await this.flushing;
    await this.flush();
  }

  /* ───────────── capture side (synchronous, cheap) ───────────── */

  private onChange(change: HubChange): void {
    if (!this.enabled || this.stopped) return;
    const now = this.now();
    const accepting = this.accepting(now);
    /** Queue one record; false when it was counted as missing instead. */
    const take = (line: RecordLine, bytes: number, content: boolean): boolean => {
      if (content) this.hasContent = true;
      if (!accepting) {
        this.gap();
        return false;
      }
      if (this.pending.length >= (this.opts.maxPendingRecords ?? MAX_PENDING_RECORDS) || this.pendingBytes + bytes > (this.opts.maxPendingBytes ?? MAX_PENDING_BYTES)) {
        this.gap();
        if (!this.pause) this.setPause({ code: 'recorder.tooSlow', message: 'Recording paused: the disk is slower than the capture' });
        return false;
      }
      this.pending.push(line);
      this.pendingBytes += bytes;
      if (this.pending.length > this.peakPending) this.peakPending = this.pending.length;
      if (!this.writer && !this.hasContent && this.pending.length > MAX_WAITING_RECORDS) {
        const dropped = this.pending.shift()!;
        this.pendingBytes -= dropped.k === 'log' ? roughBytes(dropped.v) : 256;
      }
      return true;
    };

    for (const d of change.devices ?? []) if (isRecordedDevice(d.id)) take({ k: 'device', v: d }, 512, false);
    for (const a of change.apps ?? []) {
      if (!isRecordedDevice(a.deviceId)) continue;
      take({ k: 'app', v: a }, 512, false);
      this.noteApp(a);
    }
    for (const da of change.deviceApps ?? []) if (isRecordedDevice(da.deviceId)) this.dirtyDeviceApps.set(`${da.deviceId}|${da.id}`, da);
    for (const e of change.logs ?? []) {
      if (!isRecordedDevice(e.deviceId)) continue;
      const content = e.source !== 'system';
      if (take({ k: 'log', v: e }, roughBytes(e), content) && content && e.kind !== 'network') this.countLog(e);
    }
    for (const n of change.network ?? []) {
      if (!isRecordedDevice(n.deviceId)) continue;
      this.hasContent = true;
      if (!accepting) {
        this.gap();
        continue;
      }
      const st = this.net.get(n.id);
      if (st) {
        st.entry = n;
        st.dirty = true;
      } else {
        if (!this.finalized.has(n.id)) {
          this.counts.requests++;
          if (n.deviceId && n.deviceId !== 'desktop') this.seenDevices.add(n.deviceId);
        }
        this.net.set(n.id, { entry: n, dirty: true, lastWriteAt: now });
      }
    }
    for (const m of change.metrics ?? []) if (isRecordedDevice(m.deviceId)) take({ k: 'metric', v: m }, 160, true);
    // A burst (a logcat backlog, a chatty app) is written right away instead of waiting for the timer.
    if (this.pending.length >= EARLY_FLUSH_RECORDS && !this.flushing) void this.flush();
  }

  /**
   * Whether new data is queued: always unless paused. Too slow: yes while the queue has room (take() counts the rest).
   * Low disk: no, until there is room again. A failed write: no until the next try (the gap is counted, written then).
   */
  private accepting(now: number): boolean {
    if (!this.pause || this.pause.code === 'recorder.tooSlow') return true;
    if (this.pause.code === 'recorder.diskLow') return false;
    return now >= this.retryAt;
  }

  private gap(): void {
    this.gaps++;
    this.missing++;
  }

  private countLog(e: LogEntry): void {
    this.counts.logs++;
    if (levelRank(e.level) >= ERROR_RANK) this.counts.errors++;
    if (e.kind === 'crash' || e.kind === 'anr') this.counts.crashes++;
    if (e.deviceId && e.deviceId !== 'desktop') this.seenDevices.add(e.deviceId);
  }

  private noteApp(a: AppSession): void {
    const key = `${a.deviceId}|${a.app.id}`;
    if (!this.appList.has(key) && this.appList.size >= META_LIST_MAX) return;
    this.appList.set(key, { name: a.app.name || a.app.id, bundleId: a.app.id, deviceId: a.deviceId, ...(a.app.version ? { version: a.app.version } : {}) });
  }

  /* ───────────── writing side ───────────── */

  private flush(final = false, force = false): Promise<void> {
    if (this.flushing) return this.flushing;
    const run = this.flushOnce(final, force).catch((err) => this.opts.logger.warn(`recorder flush: ${errorMessage(err)}`));
    this.flushing = run.finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  /** `force`: also when turned off (the last write of a recording being closed). */
  private async flushOnce(final: boolean, force = false): Promise<void> {
    await this.ready;
    if (!this.enabled && !force) return;
    const now = this.now();
    if (!this.hasContent) return; // nothing real yet: keep the waiting lines, write nothing
    if (!final) await this.checkFreeSpace(now);
    if (this.pause?.code === 'recorder.diskLow') return;
    if (this.pause && this.pause.code !== 'recorder.tooSlow' && now < this.retryAt && !final) return;

    const gapCount = this.gaps;
    // A gap record first: what follows came after the missing part.
    const lines: RecordLine[] = gapCount > 0 ? [{ k: 'gap', n: gapCount, ts: now }, ...this.pending] : this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    this.gaps = 0;
    this.collectNetwork(lines, now, final);
    if (final || now - this.lastDeviceAppsAt >= DEVICE_APPS_INTERVAL_MS) {
      for (const da of this.dirtyDeviceApps.values()) lines.push({ k: 'deviceApp', v: da });
      this.dirtyDeviceApps = new Map();
      this.lastDeviceAppsAt = now;
    }
    if (lines.length === 0) return;
    let written = 0;
    const writer = this.writer ?? this.openWriter(now);
    try {
      // Serialized in slices so one large flush never holds the event loop for long; each slice is one member.
      for (let at = 0; at < lines.length; at += SLICE_RECORDS) {
        if (at > 0) await new Promise<void>((resolve) => setImmediate(resolve));
        const slice = lines.slice(at, at + SLICE_RECORDS);
        await writer.append(serializeLines(slice));
        if (written === 0 && gapCount) writer.meta.gaps = (writer.meta.gaps ?? 0) + gapCount;
        written += slice.length;
      }
      writer.meta.lastWriteAt = now;
      if (this.pause) this.resume();
      if (final || now - this.lastMetaAt >= (this.opts.metaIntervalMs ?? META_INTERVAL_MS)) {
        this.lastMetaAt = now;
        await this.writeMeta();
        await writer.sync();
      }
    } catch (err) {
      const lost = lines.length - written;
      this.gaps += (written > 0 ? 0 : gapCount) + lost;
      this.missing += lost;
      this.setPause(pauseFor(err, this.opts.root));
    }
  }

  /** Requests that ended (and streams that closed) are written once with their bodies; open ones every 30 s. */
  private collectNetwork(lines: RecordLine[], now: number, final: boolean): void {
    for (const [id, st] of this.net) {
      const e = st.entry;
      const open = e.state === 'pending' || e.stream?.state === 'open';
      if (!final && open && !(st.dirty && now - st.lastWriteAt >= OPEN_SNAPSHOT_MS)) continue;
      if (!st.dirty && !final) continue;
      st.dirty = false;
      st.lastWriteAt = now;
      const detail = this.detailOf(id, e);
      if (detail) lines.push({ k: 'net', v: detail });
      if (!open) {
        this.net.delete(id);
        this.finalized.add(id);
        if (this.finalized.size > 20_000) this.finalized.clear();
      } else if (!detail) {
        this.net.delete(id); // gone from the hub meanwhile
      }
    }
  }

  private detailOf(id: string, entry: NetworkEntry): NetworkDetail | undefined {
    let detail: NetworkDetail | undefined;
    try {
      detail = this.opts.hub.getNetworkDetail(id);
    } catch {
      detail = undefined;
    }
    if (!detail) return undefined;
    if (!entry.stream || !this.opts.hub.getStreamMessages) return detail;
    const messages: StreamMessage[] = [];
    let after = 0;
    for (let i = 0; i < 100; i++) {
      const page = this.opts.hub.getStreamMessages(id, { after, limit: 2_000 });
      if (!page || page.messages.length === 0) break;
      messages.push(...page.messages);
      after = page.messages.at(-1)!.seq;
      if (!page.more) break;
    }
    return messages.length ? { ...detail, streamMessages: messages } : detail;
  }

  private openWriter(now: number): RecordingWriter {
    const meta: RecordingMeta = {
      format: RECORDING_FORMAT,
      version: 1,
      id: newRecordingId(now),
      startedAt: now,
      lastWriteAt: now,
      serverVersion: this.opts.version,
      counts: this.counts,
      devices: [],
      apps: [],
    };
    const writer = new RecordingWriter({
      root: this.opts.root,
      meta,
      header: () => this.header(),
      maxRecordingBytes: recordingLimits(this.opts.settings()).maxRecordingBytes,
      chunkBytes: this.opts.chunkBytes,
      openChunk: this.opts.openChunk,
    });
    this.writer = writer;
    this.opts.logger.debug(`recording this session to ${writer.dir}`);
    return writer;
  }

  /** What every chunk starts with: the devices, app sessions and device apps known now. */
  private header(): RecordLine[] {
    const out: RecordLine[] = [];
    const hub = this.opts.hub;
    for (const d of hub.getDevices()) if (isRecordedDevice(d.id)) out.push({ k: 'device', v: d });
    for (const a of hub.getApps()) if (isRecordedDevice(a.deviceId)) out.push({ k: 'app', v: a });
    for (const da of hub.getDeviceApps()) if (isRecordedDevice(da.deviceId)) out.push({ k: 'deviceApp', v: da });
    return out;
  }

  private async writeMeta(): Promise<void> {
    const writer = this.writer;
    if (!writer) return;
    const meta = writer.meta;
    meta.counts = { ...this.counts };
    const devices: SessionRecording['devices'] = [];
    for (const id of this.seenDevices) {
      if (devices.length >= META_LIST_MAX) break;
      const d: DeviceInfo | undefined = this.opts.hub.getDevice(id);
      if (d) devices.push({ id, name: d.name, platform: d.platform });
    }
    meta.devices = devices;
    meta.apps = [...this.appList.values()];
    await writer.writeMeta();
  }

  /** Close the recording being written (quit / turned off); a run that captured nothing leaves nothing. */
  private async finish(reason: 'quit' | 'off'): Promise<void> {
    // What is queued still belongs to the recording (turned off: nothing after this moment is written).
    await this.flushing;
    await this.flush(true, reason === 'off').catch(() => {});
    const writer = this.writer;
    this.writer = undefined;
    if (writer) {
      try {
        writer.meta.counts = { ...this.counts };
        await this.writeMetaOf(writer);
        await writer.close(this.now());
      } catch (err) {
        this.opts.logger.warn(`recorder: could not close ${writer.meta.id}: ${errorMessage(err)}`);
      }
    }
    this.pending = [];
    this.pendingBytes = 0;
    this.net.clear();
    this.finalized.clear();
    this.dirtyDeviceApps.clear();
    this.hasContent = false;
    this.gaps = 0;
    this.counts = { logs: 0, requests: 0, errors: 0, crashes: 0 };
    this.seenDevices.clear();
    this.appList.clear();
    this.pause = undefined;
    this.usedBytes = await recordingsBytes(this.opts.root).catch(() => this.usedBytes);
  }

  private async writeMetaOf(writer: RecordingWriter): Promise<void> {
    const saved = this.writer;
    this.writer = writer;
    try {
      await this.writeMeta();
    } finally {
      this.writer = saved;
    }
  }

  private async checkFreeSpace(now: number): Promise<void> {
    if (now - this.lastFreeCheck < FREE_CHECK_INTERVAL_MS) return;
    this.lastFreeCheck = now;
    const free = await (this.opts.freeBytes ?? statfsFree)(this.opts.root).catch(() => undefined);
    if (free === undefined) return;
    const min = this.opts.minFreeBytes ?? MIN_FREE_BYTES;
    if (free < min && this.pause?.code !== 'recorder.diskLow') {
      const gb = Math.round((min / 1024 ** 3) * 10) / 10;
      this.setPause({ code: 'recorder.diskLow', params: { free, min }, message: `Recording paused: less than ${gb} GB is free on this Mac's disk` });
      this.gaps += this.pending.length;
      this.pending = [];
      this.pendingBytes = 0;
    } else if (this.pause?.code === 'recorder.diskLow' && free >= min * RESUME_FREE_FACTOR) {
      this.resume();
    }
  }

  private setPause(p: Omit<RecorderPause, 'since'>): void {
    const same = this.pause?.code === p.code;
    this.pause = { ...p, since: same ? this.pause!.since : this.now() };
    this.retryAt = this.now() + (this.opts.retryMs ?? RETRY_MS);
    if (same) return;
    this.opts.logger.warn(p.message);
    this.systemLine(p.code, p.params, p.message, 'warn');
  }

  private resume(): void {
    if (!this.pause) return;
    this.pause = undefined;
    this.systemLine('recorder.resumed', undefined, 'Recording this session again', 'info');
  }

  private clearPause(): void {
    this.pause = undefined;
    this.retryAt = 0;
  }

  private systemLine(code: string, params: I18nParams | undefined, message: string, level: 'info' | 'warn'): void {
    try {
      this.opts.hub.pushSystemLog('', { code, ...(params ? { params } : {}), message, level, kind: 'lifecycle' });
    } catch {
      /* the hub is gone (stop) */
    }
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const keep = new Set<string>();
      if (this.currentId) keep.add(this.currentId);
      const removed = await sweepRecordings(this.opts.root, recordingLimits(this.opts.settings()), keep, this.now());
      if (removed.length) this.opts.logger.debug(`removed old recordings: ${removed.join(', ')}`);
      this.usedBytes = await recordingsBytes(this.opts.root);
    } catch (err) {
      this.opts.logger.debug(`recordings sweep: ${errorMessage(err)}`);
    } finally {
      this.sweeping = false;
    }
  }
}

export type RecorderHub = HubPart;
