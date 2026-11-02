/**
 * Performance view model — pure functions (no React, no stores) so they are easy to test:
 * targets, sample selection, gaps, stats, per-second rate buckets and CSV.
 */
import type { AppSession, DeviceInfo, MetricSample } from '@durbun/protocol';

/* ───────────── Windows ───────────── */

export type PerfWindow = '1m' | '5m' | '15m' | 'all';
export const PERF_WINDOWS: readonly PerfWindow[] = ['1m', '5m', '15m', 'all'];
export const WINDOW_MS: Record<Exclude<PerfWindow, 'all'>, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000 };
/** How far back "all" and the rate buckets reach (the server keeps ≤ 3600 samples per series). */
export const MAX_HISTORY_MS = 2 * 60 * 60 * 1000;
/** Device clocks may run a little ahead of the desktop; keep that much "future" data. */
const FUTURE_SLACK_MS = 10 * 60 * 1000;

export function isPerfWindow(v: unknown): v is PerfWindow {
  return typeof v === 'string' && (PERF_WINDOWS as readonly string[]).includes(v);
}

/**
 * Visible time range [from, to] in ms. `to` is "now" (or the pause time) but never earlier than the newest
 * data point (device clocks can be ahead). "all" starts at the oldest data point (bounded by MAX_HISTORY_MS).
 */
export function windowRange(win: PerfWindow, now: number, newestTs: number | undefined, oldestTs: number | undefined): { from: number; to: number } {
  const to = newestTs !== undefined && newestTs > now && newestTs - now < FUTURE_SLACK_MS ? newestTs : now;
  if (win !== 'all') return { from: to - WINDOW_MS[win], to };
  const floor = to - MAX_HISTORY_MS;
  const oldest = oldestTs !== undefined && Number.isFinite(oldestTs) ? Math.max(floor, oldestTs) : to - WINDOW_MS['5m'];
  // Keep at least one minute visible so a fresh target does not render a 2-second-wide chart.
  return { from: Math.min(oldest, to - WINDOW_MS['1m']), to };
}

/** Bucket size (s) for the rate charts: calmer lines on wide windows. */
export function rateStepSec(spanMs: number): number {
  if (spanMs <= 90_000) return 1;
  if (spanMs <= 6 * 60_000) return 2;
  if (spanMs <= 20 * 60_000) return 5;
  if (spanMs <= 65 * 60_000) return 10;
  return 20;
}

/* ───────────── Targets ───────────── */

export type PerfTarget =
  /** An app (all sessions of one bundle id on one device — relaunches stay in one chart). */
  | { kind: 'app'; deviceId: string; bundleId: string; appId: string }
  /** A device process, measured by polling (`metrics.watch`). */
  | { kind: 'process'; deviceId: string; pid: number; name?: string };

export function targetKey(t: PerfTarget | null | undefined): string {
  if (!t) return '';
  return t.kind === 'app' ? `app|${t.deviceId}|${t.bundleId}` : `proc|${t.deviceId}|${t.pid}`;
}

export function appTargetOf(app: Pick<AppSession, 'id' | 'deviceId' | 'app'>): PerfTarget {
  return { kind: 'app', deviceId: app.deviceId, bundleId: app.app.id, appId: app.id };
}

/** Sessions of an app target (same device + bundle id), newest first. */
export function targetSessions(t: PerfTarget | null | undefined, apps: Record<string, AppSession>): AppSession[] {
  if (!t || t.kind !== 'app') return [];
  return Object.values(apps)
    .filter((a) => a.deviceId === t.deviceId && a.app.id === t.bundleId)
    .sort((a, b) => Number(b.connected) - Number(a.connected) || b.connectedAt - a.connectedAt);
}

/**
 * Everything about the app sessions a view renders, except the per-log `stats` counters (the server pushes an
 * app update with every log line). Views subscribe to this key so they re-render only on real changes.
 */
export function appsStructureKey(apps: Record<string, AppSession>, opts: { actions?: boolean } = {}): string {
  let out = '';
  for (const a of Object.values(apps)) {
    out += `${a.id}|${a.deviceId}|${a.app.id}|${a.app.name}|${a.app.version ?? ''}|${a.app.pid ?? ''}|${a.app.debug ? 1 : 0}|${a.connected ? 1 : 0}|${a.connectedAt}|${a.transport}|${a.sdk.platform}|${a.capabilities.join(',')}`;
    if (opts.actions) for (const x of a.actions) out += `|${x.id}:${x.kind}:${String(x.value ?? '')}:${x.label}:${x.options?.length ?? 0}`;
    out += '\n';
  }
  return out;
}

/** Devices whose processes can be polled (live and demo devices — not imported, network-only or desktop). */
export function canPoll(d: Pick<DeviceInfo, 'id' | 'state'> | undefined): boolean {
  if (!d || d.state !== 'online') return false;
  return !(d.id.startsWith('import:') || d.id.startsWith('net:') || d.id === 'desktop');
}

export function hasMetricsCapability(a: Pick<AppSession, 'capabilities'>): boolean {
  return a.capabilities.includes('metrics');
}

/**
 * Default target for a scope: the scoped app; on a device/all scope the connected app with the metrics
 * capability that connected most recently (else the most recent one that has metric samples).
 */
export function defaultTarget(
  scope: { kind: 'all' } | { kind: 'device'; deviceId: string } | { kind: 'app'; appId: string },
  apps: Record<string, AppSession>,
  hasSamples: (app: AppSession) => boolean = () => false,
): PerfTarget | null {
  if (scope.kind === 'app') {
    const app = apps[scope.appId];
    return app ? appTargetOf(app) : null;
  }
  const list = Object.values(apps).filter((a) => scope.kind === 'all' || a.deviceId === scope.deviceId);
  const rank = (a: AppSession) => (a.connected && hasMetricsCapability(a) ? 3 : hasSamples(a) ? 2 : hasMetricsCapability(a) ? 1 : 0);
  let best: AppSession | undefined;
  for (const a of list) {
    if (rank(a) === 0) continue;
    if (!best || rank(a) > rank(best) || (rank(a) === rank(best) && a.connectedAt > best.connectedAt)) best = a;
  }
  return best ? appTargetOf(best) : null;
}

/* ───────────── Samples ───────────── */

export type MetricField = 'cpu' | 'memoryMB' | 'heapMB' | 'fps' | 'jankyFrames' | 'frameBuildMs' | 'frameRasterMs' | 'threads';
export const METRIC_FIELDS: readonly MetricField[] = ['cpu', 'memoryMB', 'heapMB', 'fps', 'jankyFrames', 'frameBuildMs', 'frameRasterMs', 'threads'];

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function fieldValue(s: MetricSample, field: MetricField): number | undefined {
  return num(s[field]);
}

/** Merge ts-ordered sample arrays into one ts-ordered array (no copy when there is a single source). */
export function mergeSamples(lists: readonly (readonly MetricSample[])[]): readonly MetricSample[] {
  const nonEmpty = lists.filter((l) => l.length > 0);
  if (nonEmpty.length === 0) return [];
  if (nonEmpty.length === 1) return nonEmpty[0]!;
  const out = nonEmpty.flat();
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** First index with ts >= `ts` (samples are ts-ordered). */
export function lowerBoundTs(samples: readonly MetricSample[], ts: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid]!.ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Samples with from <= ts <= to. */
export function sliceByTime(samples: readonly MetricSample[], from: number, to: number): readonly MetricSample[] {
  const a = lowerBoundTs(samples, from);
  let b = lowerBoundTs(samples, to);
  while (b < samples.length && samples[b]!.ts <= to) b++;
  return a === 0 && b === samples.length ? samples : samples.slice(a, b);
}

/** Median spacing of the last samples (ms); 1000 when unknown. */
export function typicalIntervalMs(samples: readonly MetricSample[]): number {
  const diffs: number[] = [];
  for (let i = Math.max(1, samples.length - 40); i < samples.length; i++) {
    const d = samples[i]!.ts - samples[i - 1]!.ts;
    if (d > 0) diffs.push(d);
  }
  if (diffs.length === 0) return 1000;
  diffs.sort((a, b) => a - b);
  return diffs[diffs.length >> 1]!;
}

/** A gap longer than this breaks the line (app restarted, polling stopped, device unplugged). */
export function gapThresholdMs(intervalMs: number): number {
  return Math.max(5000, intervalMs * 3.5);
}

/**
 * Per-field source: the app's own samples when they carry the field in the window, else the supplementary
 * (polled process) samples — e.g. CPU/RSS of a Flutter app attached through the VM service (heap only).
 */
export function chooseFieldSource(
  primary: readonly MetricSample[],
  supplement: readonly MetricSample[],
  field: MetricField,
): { samples: readonly MetricSample[]; source: 'primary' | 'supplement' | 'none' } {
  if (primary.some((s) => fieldValue(s, field) !== undefined)) return { samples: primary, source: 'primary' };
  if (supplement.some((s) => fieldValue(s, field) !== undefined)) return { samples: supplement, source: 'supplement' };
  return { samples: [], source: 'none' };
}

/** Janky frames per second for one sample (jankyFrames counts frames since the previous sample). */
export function jankPerSecond(s: MetricSample, prev: MetricSample | undefined, intervalMs: number): number | undefined {
  const jank = num(s.jankyFrames);
  if (jank === undefined) return undefined;
  const dtMs = prev ? s.ts - prev.ts : intervalMs;
  const dt = Math.min(10, Math.max(0.25, dtMs / 1000));
  return jank / dt;
}

export interface Points {
  /** x in seconds (uPlot time scale). */
  xs: number[];
  ys: (number | null)[];
}

export interface PointOptions {
  /** Flutter only paints on change: absent/0 fps means idle → a gap, never a fake drop to 0 (SPEC §9.4). */
  zeroIsIdle?: boolean;
  /** Break the line when consecutive samples are further apart than this (ms). */
  gapMs?: number;
  /** Derived value instead of the raw field (e.g. janky frames per second). */
  value?: (s: MetricSample, prev: MetricSample | undefined) => number | undefined;
}

/** Chart points for one field: samples without the value are skipped, long pauses become gaps (null). */
export function toPoints(samples: readonly MetricSample[], field: MetricField, opts: PointOptions = {}): Points {
  const xs: number[] = [];
  const ys: (number | null)[] = [];
  const gapMs = opts.gapMs ?? Infinity;
  let prev: MetricSample | undefined;
  let lastTs: number | undefined;
  for (const s of samples) {
    let v = opts.value ? opts.value(s, prev) : fieldValue(s, field);
    prev = s;
    if (opts.zeroIsIdle) {
      if (v === undefined || v <= 0) v = undefined;
      if (v === undefined) {
        // Idle sample: keep its position as a gap so the line does not bridge idle periods.
        if (lastTs !== undefined && ys[ys.length - 1] !== null) {
          xs.push(s.ts / 1000);
          ys.push(null);
          lastTs = s.ts;
        }
        continue;
      }
    } else if (v === undefined) continue;
    if (lastTs !== undefined && s.ts - lastTs > gapMs && ys[ys.length - 1] !== null) {
      xs.push((lastTs + (s.ts - lastTs) / 2) / 1000);
      ys.push(null);
    }
    xs.push(s.ts / 1000);
    ys.push(v);
    lastTs = s.ts;
  }
  return { xs, ys };
}

/** Align several point lists on one x array (missing → undefined, which uPlot skips; null stays a gap). */
export function joinPoints(list: readonly Points[]): { xs: number[]; ys: (number | null | undefined)[][] } {
  if (list.length === 0) return { xs: [], ys: [] };
  if (list.length === 1) return { xs: list[0]!.xs, ys: [list[0]!.ys] };
  const set = new Set<number>();
  for (const p of list) for (const x of p.xs) set.add(x);
  const xs = [...set].sort((a, b) => a - b);
  const index = new Map<number, number>();
  xs.forEach((x, i) => index.set(x, i));
  const ys = list.map((p) => {
    const arr: (number | null | undefined)[] = new Array(xs.length).fill(undefined);
    p.xs.forEach((x, i) => {
      arr[index.get(x)!] = p.ys[i];
    });
    return arr;
  });
  return { xs, ys };
}

/* ───────────── Stats ───────────── */

export interface FieldStats {
  /** Value of the newest sample that has the field (undefined when that sample is idle/missing). */
  now?: number;
  nowTs?: number;
  avg?: number;
  peak?: number;
  /** Samples with a value. */
  count: number;
  /** Newest sample is idle (fps absent/0 on Flutter). */
  idle: boolean;
  /** Recent values (oldest first) for a sparkline. */
  trend: number[];
}

/** Down-sample values to at most `max` points (mean per bucket). */
export function downsample(values: readonly number[], max = 48): number[] {
  if (values.length <= max) return values.slice();
  const out: number[] = [];
  const step = values.length / max;
  for (let i = 0; i < max; i++) {
    const a = Math.floor(i * step);
    const b = Math.max(a + 1, Math.floor((i + 1) * step));
    let sum = 0;
    for (let j = a; j < b; j++) sum += values[j]!;
    out.push(sum / (b - a));
  }
  return out;
}

export function fieldStats(samples: readonly MetricSample[], field: MetricField, opts: { zeroIsIdle?: boolean } = {}): FieldStats {
  let sum = 0;
  let count = 0;
  let peak: number | undefined;
  const values: number[] = [];
  for (const s of samples) {
    const v = fieldValue(s, field);
    if (v === undefined || (opts.zeroIsIdle && v <= 0)) continue;
    sum += v;
    count++;
    if (peak === undefined || v > peak) peak = v;
    values.push(v);
  }
  const last = samples[samples.length - 1];
  let now: number | undefined;
  let nowTs: number | undefined;
  let idle = false;
  if (opts.zeroIsIdle && last) {
    const v = fieldValue(last, field);
    if (v === undefined || v <= 0) idle = true;
    else {
      now = v;
      nowTs = last.ts;
    }
  } else {
    for (let i = samples.length - 1; i >= 0; i--) {
      const v = fieldValue(samples[i]!, field);
      if (v !== undefined) {
        now = v;
        nowTs = samples[i]!.ts;
        break;
      }
    }
  }
  return { now, nowTs, avg: count > 0 ? sum / count : undefined, peak, count, idle, trend: downsample(values) };
}

export interface JankStats {
  /** Janky frames per second in the newest sample. */
  perSecNow?: number;
  /** Janky frames as a share of rendered frames over the window (fps × Δt). */
  percent?: number;
  /** Janky frames in the window. */
  total: number;
  /** Samples that reported jank. */
  count: number;
  trend: number[];
}

export function jankStats(samples: readonly MetricSample[], intervalMs: number): JankStats {
  let total = 0;
  let frames = 0;
  let count = 0;
  let perSecNow: number | undefined;
  const values: number[] = [];
  let prev: MetricSample | undefined;
  for (const s of samples) {
    const jank = num(s.jankyFrames);
    const fps = num(s.fps);
    const dtMs = prev ? s.ts - prev.ts : intervalMs;
    const dt = Math.min(10, Math.max(0.25, dtMs / 1000));
    if (jank !== undefined) {
      total += jank;
      count++;
      perSecNow = jank / dt;
      values.push(perSecNow);
    }
    if (fps !== undefined && fps > 0) frames += fps * dt;
    prev = s;
  }
  return { perSecNow, percent: frames > 0 && count > 0 ? Math.min(100, (100 * total) / frames) : undefined, total, count, trend: downsample(values) };
}

/* ───────────── Per-second rate buckets (logs / requests) ───────────── */

export interface RateCounts {
  logs: number;
  errorLogs: number;
  requests: number;
  failedRequests: number;
}
export type RateKind = keyof RateCounts;

const emptyCounts = (): RateCounts => ({ logs: 0, errorLogs: 0, requests: 0, failedRequests: 0 });

/** Counts per epoch second, bounded to MAX_HISTORY_MS around "now". */
export class RateBuckets {
  private readonly map = new Map<number, RateCounts>();
  private minSec = Infinity;

  add(tsMs: number, kind: RateKind, n = 1, nowMs: number = Date.now()): void {
    if (!Number.isFinite(tsMs) || tsMs < nowMs - MAX_HISTORY_MS || tsMs > nowMs + FUTURE_SLACK_MS) return;
    const sec = Math.floor(tsMs / 1000);
    let b = this.map.get(sec);
    if (!b) {
      b = emptyCounts();
      this.map.set(sec, b);
      if (sec < this.minSec) this.minSec = sec;
    }
    b[kind] += n;
  }

  get(sec: number): RateCounts | undefined {
    return this.map.get(sec);
  }

  count(sec: number, kind: RateKind): number {
    return this.map.get(sec)?.[kind] ?? 0;
  }

  /** Per-second counts for [fromSec, toSec] (inclusive), zero-filled. */
  series(fromSec: number, toSec: number, kind: RateKind): number[] {
    const out: number[] = [];
    for (let s = fromSec; s <= toSec; s++) out.push(this.count(s, kind));
    return out;
  }

  sum(fromSec: number, toSec: number, kind: RateKind): number {
    let total = 0;
    if (toSec - fromSec + 1 > this.map.size) {
      for (const [sec, c] of this.map) if (sec >= fromSec && sec <= toSec) total += c[kind];
    } else for (let s = fromSec; s <= toSec; s++) total += this.count(s, kind);
    return total;
  }

  /** Oldest second with data (undefined when empty). */
  earliestSec(): number | undefined {
    return this.map.size > 0 ? this.minSec : undefined;
  }

  prune(minSec: number): void {
    if (this.minSec >= minSec) return;
    let newMin = Infinity;
    for (const sec of [...this.map.keys()]) {
      if (sec < minSec) this.map.delete(sec);
      else if (sec < newMin) newMin = sec;
    }
    this.minSec = newMin;
  }

  clear(): void {
    this.map.clear();
    this.minSec = Infinity;
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Rate series averaged over steps of `stepSec` seconds (value = events per second), x = step start (s).
 * Only complete seconds up to `toSec` count, so the right edge never dips just because the current second
 * has not finished yet.
 */
export function rateSeries(
  buckets: RateBuckets,
  fromSec: number,
  toSec: number,
  stepSec: number,
  kinds: readonly RateKind[],
): { xs: number[]; ys: number[][] } {
  const xs: number[] = [];
  const ys: number[][] = kinds.map(() => []);
  if (toSec < fromSec) return { xs, ys };
  const step = Math.max(1, Math.floor(stepSec));
  const first = Math.floor(fromSec / step) * step;
  for (let s = first; s <= toSec; s += step) {
    const a = Math.max(s, fromSec);
    const b = Math.min(s + step - 1, toSec);
    const n = b - a + 1;
    if (n <= 0) continue;
    xs.push(s);
    kinds.forEach((k, i) => ys[i]!.push(buckets.sum(a, b, k) / n));
  }
  return { xs, ys };
}

export interface RateStats {
  /** Average of the last 3 complete seconds. */
  now: number;
  /** Average per second over the window. */
  avg: number;
  /** Events in the window. */
  total: number;
  trend: number[];
}

export function rateStats(buckets: RateBuckets, fromSec: number, toSec: number, kind: RateKind): RateStats {
  const span = Math.max(1, toSec - fromSec + 1);
  const total = buckets.sum(fromSec, toSec, kind);
  const recentFrom = Math.max(fromSec, toSec - 2);
  const now = buckets.sum(recentFrom, toSec, kind) / Math.max(1, toSec - recentFrom + 1);
  return { now, avg: total / span, total, trend: downsample(buckets.series(fromSec, toSec, kind)) };
}

/* ───────────── CSV ───────────── */

export interface PerSecondRow extends RateCounts {
  /** Epoch second. */
  sec: number;
  cpu?: number;
  memoryMB?: number;
  heapMB?: number;
  fps?: number;
  jankyFrames?: number;
  frameBuildMs?: number;
  frameRasterMs?: number;
  threads?: number;
}

/** Gauges are averaged within a second; janky frames are summed. */
const SUMMED: ReadonlySet<MetricField> = new Set(['jankyFrames']);

/**
 * One row per second of [fromSec, toSec]: metric columns from each field's chosen source (empty when no sample
 * fell in that second) plus log/request counts.
 */
export function perSecondRows(
  fieldSamples: Partial<Record<MetricField, readonly MetricSample[]>>,
  buckets: readonly RateBuckets[],
  fromSec: number,
  toSec: number,
): PerSecondRow[] {
  const rows: PerSecondRow[] = [];
  if (toSec < fromSec) return rows;
  const index = new Map<number, PerSecondRow>();
  for (let s = fromSec; s <= toSec; s++) {
    const row: PerSecondRow = { sec: s, logs: 0, errorLogs: 0, requests: 0, failedRequests: 0 };
    for (const b of buckets) {
      const c = b.get(s);
      if (!c) continue;
      row.logs += c.logs;
      row.errorLogs += c.errorLogs;
      row.requests += c.requests;
      row.failedRequests += c.failedRequests;
    }
    rows.push(row);
    index.set(s, row);
  }
  for (const field of METRIC_FIELDS) {
    const samples = fieldSamples[field];
    if (!samples || samples.length === 0) continue;
    const acc = new Map<number, { sum: number; n: number }>();
    for (const smp of sliceByTime(samples, fromSec * 1000, toSec * 1000 + 999)) {
      const v = fieldValue(smp, field);
      if (v === undefined) continue;
      const sec = Math.floor(smp.ts / 1000);
      const a = acc.get(sec);
      if (a) {
        a.sum += v;
        a.n++;
      } else acc.set(sec, { sum: v, n: 1 });
    }
    for (const [sec, a] of acc) {
      const row = index.get(sec);
      if (row) row[field] = SUMMED.has(field) ? a.sum : a.sum / a.n;
    }
  }
  return rows;
}

export const CSV_COLUMNS = [
  'time',
  'epoch_ms',
  'cpu_percent',
  'memory_mb',
  'heap_mb',
  'fps',
  'janky_frames',
  'frame_build_ms',
  'frame_raster_ms',
  'threads',
  'logs',
  'error_logs',
  'requests',
  'failed_requests',
] as const;

function csvNumber(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '';
  return String(Math.round(v * 100) / 100);
}

export function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** RFC 4180 CSV (comma separator, dot decimals, UTC ISO times) — loads in spreadsheets and pandas alike. */
export function rowsToCsv(rows: readonly PerSecondRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    const ms = r.sec * 1000;
    lines.push(
      [
        new Date(ms).toISOString().replace('.000Z', 'Z'),
        String(ms),
        csvNumber(r.cpu),
        csvNumber(r.memoryMB),
        csvNumber(r.heapMB),
        csvNumber(r.fps),
        csvNumber(r.jankyFrames),
        csvNumber(r.frameBuildMs),
        csvNumber(r.frameRasterMs),
        csvNumber(r.threads),
        String(r.logs),
        String(r.errorLogs),
        String(r.requests),
        String(r.failedRequests),
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

const TR_ASCII: Record<string, string> = { ı: 'i', İ: 'I', ş: 's', Ş: 'S', ğ: 'g', Ğ: 'G', ü: 'u', Ü: 'U', ö: 'o', Ö: 'O', ç: 'c', Ç: 'C' };

/** File-name-safe ASCII slug ("Pati · Pixel 8" → "pati-pixel-8"). */
export function slugify(text: string): string {
  const ascii = text
    .replace(/[ıİşŞğĞüÜöÖçÇ]/g, (c) => TR_ASCII[c] ?? c)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
  return (
    ascii
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'target'
  );
}

export function csvFileName(label: string, now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `durbun-perf-${slugify(label)}-${stamp}.csv`;
}

/* ───────────── Axis helpers ───────────── */

/** Smallest "nice" number (1, 2, 2.5, 5 × 10^k) >= v. */
export function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  for (const m of [1, 2, 2.5, 5, 10]) {
    const c = m * base;
    if (c >= v - 1e-9) return c;
  }
  return 10 * base;
}

/**
 * Y range from 0 to a nice ceiling with ~12 % headroom, at least `softMax`. With `snap`, data that stays
 * within `softMax` uses exactly [0, softMax] (FPS: 0–60 / 0–120).
 */
export function yRange(dataMax: number | null | undefined, softMax = 1, snap = false): [number, number] {
  const m = typeof dataMax === 'number' && Number.isFinite(dataMax) ? dataMax : 0;
  if (snap && m <= softMax) return [0, softMax];
  return [0, niceCeil(Math.max(softMax, m * 1.12))];
}
