/**
 * Frame statistics for any Android build (SPEC §10.4), read only while a metrics watch is on:
 *
 *  - native UI (HWUI): `dumpsys gfxinfo <pkg> reset` prints the counters since the previous reset and
 *    resets them ("Uptime: <ms>", "Stats since: <ns>ns", "Total frames rendered: N", "Janky frames: J (x%)").
 *  - Flutter (FlutterSurfaceView — invisible to HWUI): `dumpsys SurfaceFlinger --latency '<layer>'` prints
 *    the refresh period (ns) and the last 127 frames as "desiredPresent\tactualPresent\tframeReady" (ns,
 *    CLOCK_MONOTONIC; 0 = empty slot, INT64_MAX = fence still pending). The layer comes from
 *    `dumpsys SurfaceFlinger --list` (a line containing "<pkg>/" and "SurfaceView"; "(BLAST)" preferred).
 *
 * One `adb shell` call per 2 s tick (gfxinfo + latency [+ --list when the layer is unknown/stale]).
 * SurfaceFlinger data wins when it has frames. Nothing is emitted when neither source works.
 */
import type { Logger } from '../../types';
import type { Adb } from './adb';

/* ───────────────────────────── parsers ───────────────────────────── */

export interface GfxInfoStats {
  /** Frames rendered since the last reset (all processes of the package). */
  frames: number;
  janky: number;
  /** Uptime − "Stats since" of the busiest process, when both are printed. */
  windowMs?: number;
  processes: number;
}

/** `dumpsys gfxinfo <pkg> [reset]`; undefined when the package has no process / no stats. */
export function parseGfxInfo(text: string): GfxInfoStats | undefined {
  if (!/Total frames rendered:/.test(text)) return undefined;
  const uptimeMs = Number(/^Uptime: (\d+)/m.exec(text)?.[1] ?? NaN);
  // Split per process ("** Graphics info for pid 4321 [com.foo] **"); older releases print one block.
  const sections = text.split(/^\*\* Graphics info for pid \d+ \[[^\]]*\] \*\*\s*$/m);
  const blocks = sections.length > 1 ? sections.slice(1) : sections;
  let frames = 0;
  let janky = 0;
  let processes = 0;
  let busiest = -1;
  let windowMs: number | undefined;
  for (const b of blocks) {
    const f = /^Total frames rendered: (\d+)/m.exec(b);
    if (!f) continue;
    processes += 1;
    const n = Number(f[1]);
    frames += n;
    const j = /^Janky frames: (\d+)/m.exec(b);
    if (j) janky += Number(j[1]);
    if (n > busiest) {
      busiest = n;
      const since = /^Stats since: (\d+)ns/m.exec(b);
      const w = since && Number.isFinite(uptimeMs) ? uptimeMs - Number(since[1]) / 1e6 : NaN;
      windowMs = Number.isFinite(w) && w > 0 ? w : undefined;
    }
  }
  if (!processes) return undefined;
  const out: GfxInfoStats = { frames, janky, processes };
  if (windowMs !== undefined) out.windowMs = windowMs;
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * SurfaceView buffer layers of `pkg` from `dumpsys SurfaceFlinger --list`:
 *   Android ≤ 11  "SurfaceView - com.foo/com.foo.MainActivity#0"
 *   Android 12+   "SurfaceView[com.foo/com.foo.MainActivity](BLAST)#1"   (container without "(BLAST)")
 *   Android 13+   "SurfaceView[com.foo/com.foo.MainActivity]@0(BLAST)#523"
 *   Android 15+   "RequestedLayerState{SurfaceView[…]@0(BLAST)#523 parentId=522}" (new frontend's debug
 *                 string; `--latency` still wants the bare name inside)
 * "Background for …" layers are skipped; "(BLAST)" layers win when present. At most 3.
 */
export function findSurfaceViewLayers(listText: string, pkg: string): string[] {
  const owner = new RegExp(`(?:^|[^A-Za-z0-9_.])${escapeRe(pkg)}/`);
  const all: string[] = [];
  for (const raw of listText.split('\n')) {
    const line = layerName(raw.trim());
    if (!line || line.length > 512 || !line.includes('SurfaceView')) continue;
    if (line.startsWith('Background for') || !owner.test(line)) continue;
    if (!all.includes(line)) all.push(line);
  }
  const blast = all.filter((l) => l.includes('(BLAST)'));
  return (blast.length ? blast : all).slice(0, 3);
}

const REQUESTED_LAYER_RE = /^RequestedLayerState\{(.*?)(?= (?:parentId|relativeParentId|mirrorId|z|layerStack)=| !handle|\}$)/;

/** One `--list` line → the layer name `--latency` matches (unwraps Android 15's RequestedLayerState{…}). */
function layerName(line: string): string {
  if (!line.startsWith('RequestedLayerState{')) return line;
  return REQUESTED_LAYER_RE.exec(line)?.[1]?.trim() ?? '';
}

export interface SfLatency {
  refreshNs?: number;
  /** Valid actual-present timestamps (ns), ascending. */
  presents: number[];
  /** Frame rows printed (incl. empty ones). */
  rows: number;
}

/** `dumpsys SurfaceFlinger --latency '<layer>'`; undefined when the first line is not the refresh period. */
export function parseSfLatency(text: string): SfLatency | undefined {
  const lines = text.split('\n').map((l) => l.trim());
  let i = 0;
  while (i < lines.length && lines[i] === '') i += 1;
  const first = lines[i];
  if (first === undefined || !/^\d+$/.test(first)) return undefined;
  const refresh = Number(first);
  const out: SfLatency = { presents: [], rows: 0 };
  if (refresh > 0 && refresh < 1e9) out.refreshNs = refresh;
  for (i += 1; i < lines.length; i++) {
    const m = /^(\d+)\s+(\d+)\s+(\d+)$/.exec(lines[i]!);
    if (!m) continue;
    out.rows += 1;
    const actual = m[2]!;
    // INT64_MAX = present fence not signalled yet; 0 = empty slot.
    if (actual === '0' || actual.length > 17) continue;
    const v = Number(actual);
    if (v > 0) out.presents.push(v);
  }
  out.presents.sort((a, b) => a - b);
  return out;
}

/** Gaps longer than this are idle time (Flutter paints only on change), not jank. */
export const IDLE_GAP_MS = 500;

/** Frames whose interval exceeds 1.5 × the median interval (intervals ≤ IDLE_GAP_MS only). */
export function jankCount(intervalsMs: number[], idleGapMs = IDLE_GAP_MS): number {
  const usable = intervalsMs.filter((x) => x > 0 && x <= idleGapMs);
  if (usable.length < 3) return 0;
  const sorted = [...usable].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return usable.filter((x) => x > 1.5 * median).length;
}

export interface SfWindow {
  /** false on the first read of a layer (baseline only). */
  primed: boolean;
  /** Newest present seen (the next baseline). */
  newMax: number;
  frames?: number;
  fps?: number;
  janky?: number;
}

/**
 * Frames presented since `prevMax` (the newest present of the previous read). fps = new frames /
 * elapsed; when every row is new (the 127-frame ring wrapped between reads) fps = rate over the span.
 */
export function sfFrameWindow(lat: SfLatency, prevMax: number | undefined, elapsedMs: number): SfWindow {
  const p = lat.presents;
  const max = p.length ? p[p.length - 1]! : (prevMax ?? 0);
  if (prevMax === undefined) return { primed: false, newMax: max };
  const fresh = p.filter((x) => x > prevMax);
  const newMax = Math.max(prevMax, max);
  if (!fresh.length) return { primed: true, newMax, frames: 0, fps: 0, janky: 0 };
  const wrapped = p.length >= Math.max(lat.rows - 2, 100) && p[0]! > prevMax;
  let fps: number;
  if (wrapped && fresh.length > 1) fps = (fresh.length - 1) / ((fresh[fresh.length - 1]! - fresh[0]!) / 1e9);
  else fps = elapsedMs > 0 ? fresh.length / (elapsedMs / 1000) : 0;
  if (lat.refreshNs) {
    const rate = 1e9 / lat.refreshNs;
    if (fps > rate && fps <= rate * 1.15) fps = rate; // timer jitter, not more frames than the display shows
  }
  const seq = prevMax > 0 && fresh[0]! - prevMax <= IDLE_GAP_MS * 1e6 ? [prevMax, ...fresh] : fresh;
  const intervals: number[] = [];
  for (let i = 1; i < seq.length; i++) intervals.push((seq[i]! - seq[i - 1]!) / 1e6);
  return { primed: true, newMax, frames: fresh.length, fps: round1(fps), janky: jankCount(intervals) };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/* ───────────────────────────── reader ───────────────────────────── */

export const FRAME_GFX_MARK = '___DURBUN_GFX___';
export const FRAME_SF_MARK = '___DURBUN_SF___';
export const FRAME_LIST_MARK = '___DURBUN_SFLIST___';

export const FRAME_TIMING = {
  timeoutMs: 3000,
  /** Re-list layers while none is known: every 10 s during the first minute, then every 30 s. */
  relistFastMs: 10_000,
  relistSlowMs: 30_000,
  fastPhaseMs: 60_000,
  /** Reads without any sample since a watch began before frame stats count as unavailable (≈ 10 s). */
  noDataReads: 5,
};

export interface FrameSample {
  fps: number;
  jankyFrames: number;
  source: 'surfaceflinger' | 'gfxinfo';
}

export interface FrameStatsDeps {
  serial: string;
  logger: Logger;
  /** Package of the watched process (re-evaluated every tick; undefined while unknown). */
  packageName: () => string | undefined;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;

export class FrameStatsReader {
  private pkg?: string;
  private startedAt = 0;
  private layers: string[] = [];
  private nextListAt = 0;
  private emptyStreak = 0;
  private everHadLayer = false;
  private readonly sf = new Map<string, { max: number; at: number }>();
  private gfxPrimed = false;
  private gfxAt = 0;
  private gfxSeen = false;
  private inFlight = false;
  private failure?: string;
  /** The last read(): 'sample' = fps reported, 'none' = read but nothing to report, 'skipped' = not read. */
  lastRead: 'sample' | 'none' | 'skipped' = 'skipped';

  constructor(private readonly deps: FrameStatsDeps) {}

  /** One read (≈ every 2 s). Never throws; undefined = nothing to report this tick. `nowMs`: tests. */
  async read(adb: Adb, nowMs?: number): Promise<FrameSample | undefined> {
    const now = nowMs ?? Date.now();
    const pkg = this.deps.packageName();
    if (!pkg || !PKG_RE.test(pkg) || this.inFlight) {
      this.lastRead = 'skipped';
      return undefined;
    }
    if (pkg !== this.pkg) this.reset(pkg, now);
    this.inFlight = true;
    this.lastRead = 'none';
    try {
      const wantList = !this.layers.length && now >= this.nextListAt;
      const parts = [`echo ${FRAME_GFX_MARK}`, `dumpsys gfxinfo ${pkg} reset`];
      this.layers.forEach((l, i) => parts.push(`echo ${FRAME_SF_MARK} ${i}`, `dumpsys SurfaceFlinger --latency ${shellQuote(l)}`));
      if (wantList) parts.push(`echo ${FRAME_LIST_MARK}`, 'dumpsys SurfaceFlinger --list');
      const r = await adb.shell(this.deps.serial, parts.join('; '), { timeoutMs: FRAME_TIMING.timeoutMs });
      const at = nowMs ?? Date.now();
      if (!r.stdout.trim()) {
        this.failure = r.error ?? r.stderr.trim();
        this.deps.logger.debug(`${this.deps.serial}: frame stats read failed: ${this.failure}`);
        return undefined;
      }
      this.failure = undefined;
      const sample = this.consume(r.stdout, at, wantList);
      if (sample) this.lastRead = 'sample';
      return sample;
    } catch (e) {
      this.failure = (e as Error).message;
      this.deps.logger.debug(`${this.deps.serial}: frame stats read failed: ${this.failure}`);
      return undefined;
    } finally {
      this.inFlight = false;
    }
  }

  /** Why reads give nothing (English, → DeviceInfo.readers.frameStats.detail). */
  noDataDetail(): string {
    const pkg = this.pkg ?? 'the app';
    if (this.failure !== undefined) return `Reading frame stats for ${pkg} failed${this.failure ? `: ${this.failure}` : ''}`;
    if (this.everHadLayer) {
      return `SurfaceFlinger lists a SurfaceView of ${pkg} but gives no frame times for it; gfxinfo does not see what a SurfaceView draws`;
    }
    if (!this.gfxSeen) return `dumpsys gfxinfo printed no frame stats for ${pkg}, and SurfaceFlinger lists no SurfaceView of it`;
    return `No frames could be counted for ${pkg} from gfxinfo or SurfaceFlinger`;
  }

  /** Parse one combined output (exposed for tests). */
  consume(out: string, now: number, listed: boolean): FrameSample | undefined {
    const sections = splitSections(out);
    // gfxinfo
    let gfx: { fps: number; janky: number; frames: number } | undefined;
    const g = parseGfxInfo(sections.gfx);
    if (g) {
      this.gfxSeen = true;
      if (this.gfxPrimed) {
        const windowMs = g.windowMs ?? now - this.gfxAt;
        // A window of a few ms means the counters were reset right before printing (unexpected order on
        // some build?) — then "0 frames" says nothing; report nothing rather than a false 0 fps.
        if (windowMs >= 250) gfx = { fps: round1(g.frames / (windowMs / 1000)), janky: g.janky, frames: g.frames };
      }
      this.gfxPrimed = true;
      this.gfxAt = now;
    } else this.gfxPrimed = false;

    // SurfaceFlinger latency (pick the layer with the most new frames)
    let sfBest: SfWindow | undefined;
    let sfPrimedAny = false;
    let sfEmpty = 0;
    this.layers.forEach((layer, i) => {
      const lat = parseSfLatency(sections.sf.get(i) ?? '');
      if (!lat || (!lat.presents.length && !lat.rows)) {
        sfEmpty += 1;
        return;
      }
      const st = this.sf.get(layer);
      const w = sfFrameWindow(lat, st?.max, st ? now - st.at : 0);
      this.sf.set(layer, { max: w.newMax, at: now });
      if (!w.primed) return;
      sfPrimedAny = true;
      if (!sfBest || (w.frames ?? 0) > (sfBest.frames ?? 0)) sfBest = w;
    });
    if (this.layers.length && sfEmpty === this.layers.length) {
      // Layer gone (activity recreated, app in background) or unreadable: look it up again (backing off).
      this.layers = [];
      this.emptyStreak += 1;
      this.nextListAt =
        now + (this.emptyStreak <= 1 ? 0 : this.emptyStreak <= 5 ? FRAME_TIMING.relistFastMs : FRAME_TIMING.relistSlowMs);
    } else if (this.layers.length) this.emptyStreak = 0;

    if (listed) {
      const list = sections.list;
      if (list !== undefined) {
        const found = this.pkg ? findSurfaceViewLayers(list, this.pkg) : [];
        if (found.length) {
          this.everHadLayer = true;
          for (const k of [...this.sf.keys()]) if (!found.includes(k)) this.sf.delete(k);
          this.layers = found;
        }
      }
      if (!this.layers.length) {
        const fast = now - this.startedAt < FRAME_TIMING.fastPhaseMs;
        this.nextListAt = now + (fast ? FRAME_TIMING.relistFastMs : FRAME_TIMING.relistSlowMs);
      }
    }

    const best = sfBest as SfWindow | undefined;
    if (best && (best.frames ?? 0) > 0) return { fps: best.fps ?? 0, jankyFrames: best.janky ?? 0, source: 'surfaceflinger' };
    // A SurfaceView app (Flutter) draws its content outside HWUI: without readable SurfaceFlinger data this
    // tick, gfxinfo only counts the few decor frames (or 0) — a false fps either way.
    const surfaceBlind = this.everHadLayer && !sfPrimedAny;
    if (gfx && gfx.frames > 0 && !surfaceBlind) return { fps: gfx.fps, jankyFrames: gfx.janky, source: 'gfxinfo' };
    if (sfPrimedAny) return { fps: 0, jankyFrames: 0, source: 'surfaceflinger' }; // SurfaceView idle
    if (gfx && !this.everHadLayer) return { fps: gfx.fps, jankyFrames: gfx.janky, source: 'gfxinfo' };
    return undefined;
  }

  private reset(pkg: string, now: number): void {
    this.pkg = pkg;
    this.startedAt = now;
    this.layers = [];
    this.nextListAt = 0;
    this.emptyStreak = 0;
    this.everHadLayer = false;
    this.sf.clear();
    this.gfxPrimed = false;
    this.gfxAt = 0;
    this.gfxSeen = false;
  }
}

function splitSections(out: string): { gfx: string; sf: Map<number, string>; list?: string } {
  const sf = new Map<number, string>();
  let gfx = '';
  let list: string | undefined;
  let cur: { kind: 'gfx' | 'sf' | 'list' | 'none'; i: number; lines: string[] } = { kind: 'none', i: 0, lines: [] };
  const close = () => {
    const text = cur.lines.join('\n');
    if (cur.kind === 'gfx') gfx = text;
    else if (cur.kind === 'sf') sf.set(cur.i, text);
    else if (cur.kind === 'list') list = text;
  };
  for (const raw of out.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const t = line.trim();
    if (t === FRAME_GFX_MARK) {
      close();
      cur = { kind: 'gfx', i: 0, lines: [] };
    } else if (t.startsWith(FRAME_SF_MARK)) {
      close();
      cur = { kind: 'sf', i: Number(t.slice(FRAME_SF_MARK.length).trim()) || 0, lines: [] };
    } else if (t === FRAME_LIST_MARK) {
      close();
      cur = { kind: 'list', i: 0, lines: [] };
    } else cur.lines.push(line);
  }
  close();
  return { gfx, sf, list };
}
