import type { LogEntry } from '@durbun/protocol';
import { DupIndex, crashSignature, dedupeHash, isDedupeCandidate, signatureHash, type DupCandidate } from './dedupe';
import { HistogramIndex } from './histogram';
import { F_COUNT_NOISE, F_COUNT_SRC, F_MARKER, F_NOHIST, F_NOISY, F_SRC_MASK, F_VISIBLE, Ledger, SEV_SHIFT } from './ledger';
import { isPreviousLaunch, isStructural, rankOf, severityOf, type LogRow, type RowFilter, type Severity, type SourceCounts, type StoreView } from './types';

const SRC_CODE = { device: 0, app: 1, system: 2 } as const;
const SRC_NAME = ['device', 'app', 'system'] as const;

/** Kinds that may fold into ×N rows (plain text lines only). */
function foldableKind(k: LogEntry['kind']): boolean {
  return k === undefined || k === 'text';
}

/** Identical consecutive lines: same device, source, level, tag, process, message (and payload). */
export function canFold(a: LogEntry, b: LogEntry): boolean {
  return (
    foldableKind(a.kind) &&
    foldableKind(b.kind) &&
    a.message === b.message &&
    a.tag === b.tag &&
    a.level === b.level &&
    a.source === b.source &&
    a.deviceId === b.deviceId &&
    a.process === b.process &&
    a.appId === b.appId &&
    a.data === b.data &&
    a.error === b.error
  );
}

/**
 * Incremental row builder for the virtualized log list (README §4.2 pattern):
 * - scans only entries newer than its id cursor; rebuilds on store `generation` / filter change;
 * - drops rows that fell out of the store ring with a start pointer (binary search, no shifting);
 * - folds identical consecutive lines (×N), pairs app-vs-device duplicates;
 * - keeps source/noise counters and the volume histogram exact via a ledger of counted entries.
 * Rows are immutable objects keyed by their first entry id.
 */
export class RowModel {
  rows: LogRow[] = [];
  start = 0;
  /** Rows appended since the last rebuild (monotonic) — drives the "↓ N new" pill. */
  appended = 0;
  /** Bumped on every rebuild (filter/generation change). */
  build = 0;
  /** Bumped whenever rows or counters changed. */
  version = 0;
  /** Bumped when rows were inserted, removed or the start moved (row keys at some index changed). */
  structure = 0;
  counts: SourceCounts = { device: 0, app: 0, system: 0, noise: 0, markers: 0 };
  readonly hist = new HistogramIndex();
  private readonly ledger = new Ledger(4096);
  private readonly dups = new DupIndex();
  private filter: RowFilter | null = null;
  private gen = -1;
  private lastId = 0;
  private pause: { cursor: number; count: number; gen: number } | null = null;

  get count(): number {
    return this.rows.length - this.start;
  }

  row(i: number): LogRow | undefined {
    return this.rows[this.start + i];
  }

  /** Id of the newest processed store entry. */
  get cursor(): number {
    return this.lastId;
  }

  get currentFilter(): RowFilter | null {
    return this.filter;
  }

  /** Install a filter; a different object triggers a rebuild on the next sync. */
  setFilter(f: RowFilter): boolean {
    if (f === this.filter) return false;
    this.filter = f;
    this.reset();
    return true;
  }

  reset(): void {
    this.rows = [];
    this.start = 0;
    this.appended = 0;
    this.counts = { device: 0, app: 0, system: 0, noise: 0, markers: 0 };
    this.hist.clear();
    this.ledger.clear();
    this.dups.clear();
    this.lastId = 0;
    this.gen = -1;
    this.build++;
    this.version++;
    this.structure++;
  }

  /** Bring rows up to date with the store. Returns true when anything changed. */
  sync(store: StoreView): boolean {
    if (!this.filter) return false;
    this.pause = null;
    let changed = false;
    if (store.generation !== this.gen) {
      if (this.gen !== -1) this.reset();
      this.gen = store.generation;
      changed = true;
    }
    const entries = store.entries;
    const firstId = entries.length > 0 ? entries[0]!.id : Infinity;
    if (this.dropBefore(firstId)) changed = true;
    const from = store.lowerBound(this.lastId + 1);
    for (let i = from; i < entries.length; i++) this.process(entries[i]!);
    if (from < entries.length) {
      this.lastId = entries[entries.length - 1]!.id;
      changed = true;
    }
    if (changed) this.version++;
    return changed;
  }

  /** Remove rows/records of entries the store trimmed (ids < firstId). */
  private dropBefore(firstId: number): boolean {
    let changed = false;
    const rows = this.rows;
    if (this.start < rows.length && rows[this.start]!.id < firstId) {
      let lo = this.start;
      let hi = rows.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (rows[mid]!.id < firstId) lo = mid + 1;
        else hi = mid;
      }
      this.start = lo;
      this.structure++;
      changed = true;
      if (this.start > 4096 && this.start * 2 > rows.length) {
        this.rows = rows.slice(this.start);
        this.start = 0;
      }
    }
    const led = this.ledger;
    while (led.length > 0 && led.frontId() < firstId) {
      this.uncount(led.frontTs(), led.frontFlags());
      led.dropFront();
      changed = true;
    }
    return changed;
  }

  private uncount(ts: number, flags: number): void {
    const src = SRC_NAME[flags & F_SRC_MASK]!;
    if (flags & F_COUNT_SRC) this.counts[src]--;
    if (flags & F_COUNT_NOISE) this.counts.noise--;
    if (flags & F_MARKER) this.counts.markers--;
    if (flags & F_VISIBLE && !(flags & F_NOHIST)) this.hist.remove(ts, ((flags >> SEV_SHIFT) & 3) as Severity);
  }

  /**
   * Filter stages shared by `process` and pending counting. Returns -1 when the entry is out (scope,
   * level, kind, query), else ledger flags with source/noise bits (visibility not decided yet).
   */
  private classify(e: LogEntry, f: RowFilter): number {
    if (!f.scope(e)) return -1;
    const rank = rankOf(e.level);
    if (rank < f.queryMinRank) return -1;
    if (rank < f.minRank && !isStructural(e)) return -1;
    if (e.kind === 'network' && !f.showNetwork) return -1;
    if (!f.query.matchesAll && !f.query.test(e)) return -1;
    const src = e.source === 'app' || e.source === 'system' ? e.source : 'device';
    let flags: number = SRC_CODE[src];
    if (src === 'device' && f.noise(e)) flags |= F_NOISY;
    return flags;
  }

  private sourceOn(e: LogEntry, f: RowFilter): boolean {
    return e.kind === 'marker' || f.sources[e.source] !== false;
  }

  private process(e: LogEntry): void {
    const f = this.filter!;
    let flags = this.classify(e, f);
    if (flags < 0) return;
    const src = SRC_NAME[flags & F_SRC_MASK]!;
    const noisy = (flags & F_NOISY) !== 0;
    const srcOn = this.sourceOn(e, f);
    if (!(noisy && f.hideNoise)) {
      this.counts[src]++;
      flags |= F_COUNT_SRC;
    }
    if (noisy && srcOn) {
      this.counts.noise++;
      flags |= F_COUNT_NOISE;
    }
    let visible = srcOn && !(noisy && f.hideNoise);

    // App-vs-device duplicates (same text, or the same crash told in the SDK's and the device's words).
    let twinSelf = false;
    let dkey = -1;
    let sig: string | undefined;
    if (isDedupeCandidate(e)) {
      sig = crashSignature(e) ?? undefined;
      dkey = sig !== undefined ? signatureHash(sig) : dedupeHash(e);
      const partner = this.dups.match(e, dkey, sig);
      if (partner) {
        partner.paired = true;
        dkey = -1;
        if (e.source === 'device') {
          // The app copy is on screen: mark it, hide this device copy.
          if (partner.rowId >= 0) {
            this.markTwin(partner.rowId);
            if (f.dedupe && visible) visible = false;
          }
        } else if (visible) {
          twinSelf = true;
          if (f.dedupe && partner.rowId >= 0) this.removeDeviceCopy(partner);
        }
      }
    }

    const sev = severityOf(e.level);
    flags |= sev << SEV_SHIFT;
    const noHist = e.kind === 'crash' && isPreviousLaunch(e);
    if (noHist) flags |= F_NOHIST;
    if (visible) {
      flags |= F_VISIBLE;
      if (!noHist) this.hist.add(e.ts, sev);
      if (e.kind === 'marker') {
        flags |= F_MARKER;
        this.counts.markers++;
      }
    }
    this.ledger.push(e.id, e.ts, flags);
    const rowId = visible ? this.addRow(e, twinSelf) : -1;
    if (dkey >= 0) this.dups.add({ id: e.id, ts: e.ts, deviceId: e.deviceId, message: e.message, source: e.source as 'app' | 'device', sig, rowId, paired: false, hash: dkey, prev: undefined });
  }

  private addRow(e: LogEntry, twin: boolean): number {
    const rows = this.rows;
    const len = rows.length;
    if (this.filter!.fold && len > this.start) {
      const last = rows[len - 1]!;
      if (canFold(last.e, e)) {
        rows[len - 1] = { id: last.id, e: last.e, n: last.n + 1, last: e, twin: last.twin || twin || undefined };
        return last.id;
      }
    }
    rows.push(twin ? { id: e.id, e, n: 1, twin: true } : { id: e.id, e, n: 1 });
    this.appended++;
    this.structure++;
    return e.id;
  }

  private markTwin(rowId: number): void {
    const a = this.absIndexOf(rowId);
    if (a < 0) return;
    const r = this.rows[a]!;
    if (!r.twin) this.rows[a] = { ...r, twin: true };
  }

  private removeDeviceCopy(partner: DupCandidate): void {
    const a = this.absIndexOf(partner.rowId);
    if (a >= 0) {
      const r = this.rows[a]!;
      if (r.n > 1) this.rows[a] = { ...r, n: r.n - 1 };
      else {
        this.rows.splice(a, 1);
        this.structure++;
      }
    }
    const li = this.ledger.indexOf(partner.id);
    if (li >= 0) {
      const fl = this.ledger.flagsAt(li);
      if (fl & F_VISIBLE) {
        this.ledger.setFlagsAt(li, fl & ~F_VISIBLE);
        if (!(fl & F_NOHIST)) this.hist.remove(this.ledger.tsAt(li), ((fl >> SEV_SHIFT) & 3) as Severity);
      }
    }
    partner.rowId = -1;
  }

  /* ───────────── lookups (indices are relative to `start`) ───────────── */

  private absIndexOf(id: number): number {
    const rows = this.rows;
    let lo = this.start;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (rows[mid]!.id < id) lo = mid + 1;
      else hi = mid;
    }
    return lo < rows.length && rows[lo]!.id === id ? lo : -1;
  }

  /** Index of the row with this key, or -1. */
  indexOfRow(id: number): number {
    const a = this.absIndexOf(id);
    return a < 0 ? -1 : a - this.start;
  }

  /** Index of the row showing this entry (its own row or a fold that spans it), or -1. */
  indexOfEntry(entryId: number): number {
    const rows = this.rows;
    let lo = this.start;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (rows[mid]!.id <= entryId) lo = mid + 1;
      else hi = mid;
    }
    const a = lo - 1;
    if (a < this.start) return -1;
    const r = rows[a]!;
    if (r.id === entryId) return a - this.start;
    if (r.n > 1 && r.last && r.last.id >= entryId) return a - this.start;
    return -1;
  }

  /** Index of the first row at or after this entry id (clamped), -1 when empty. */
  nearestIndex(entryId: number): number {
    if (this.count === 0) return -1;
    const rows = this.rows;
    let lo = this.start;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (rows[mid]!.id < entryId) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, rows.length - 1) - this.start;
  }

  /** First row whose timestamp is ≥ ts (rows are id-ordered; device clocks are mostly monotonic). */
  indexAtTime(ts: number): number {
    const n = this.count;
    if (n === 0) return -1;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.rows[this.start + mid]!.e.ts < ts) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, n - 1);
  }

  /* ───────────── explicit pause ───────────── */

  /**
   * While the view is frozen, count arriving entries that would become visible (no rows are built).
   * The next `sync` processes them for real.
   */
  countPending(store: StoreView): number {
    const f = this.filter;
    if (!f) return 0;
    let p = this.pause;
    if (!p) p = this.pause = { cursor: this.lastId, count: 0, gen: store.generation };
    if (p.gen !== store.generation) {
      p.gen = store.generation;
      p.cursor = 0;
      p.count = 0;
    }
    const entries = store.entries;
    const from = store.lowerBound(p.cursor + 1);
    for (let i = from; i < entries.length; i++) {
      const e = entries[i]!;
      const flags = this.classify(e, f);
      if (flags < 0 || !this.sourceOn(e, f)) continue;
      if (flags & F_NOISY && f.hideNoise) continue;
      p.count++;
    }
    if (from < entries.length) p.cursor = entries[entries.length - 1]!.id;
    return p.count;
  }
}
