/**
 * iOS crash de-duplication (SPEC §10.3). One crash often shows up twice: live, as the SDK's native crash row
 * or the app's "*** Terminating app due to uncaught exception …" device log line, and later as the .ips report
 * iOS wrote. The report entry is marked `data.duplicateOf` = id of that live entry (the UI hides marked copies
 * while de-duplication is on), like Android's dropbox copies.
 *
 * Live rows (fed from the hub's `onLogs` tap):
 *   - SDK native crash rows (tag 'crash'): "Uncaught exception …" and "Crash in previous launch: …" (sent by
 *     the next launch, with the crash's own time);
 *   - device log lines with "*** Terminating app due to uncaught exception" (printed by the dying app).
 * Dart's "Unhandled exception" rows and Flutter engine error lines are not process deaths and never match.
 *
 * A report matches a live row of the same device when the pid is the same (a device line's pid; an SDK row's
 * session pid) and the times are ≤ 60 s apart, or the bundle id is the same (SDK rows; previous-launch rows
 * match this way only) and the times are ≤ 10 s apart. Pid matches win, then the closest time; each live row
 * absorbs one report. Not de-duplicated (both stay visible): a live row that arrives after the report was
 * read, e.g. "Crash in previous launch" from an app relaunched more than one scan after it crashed.
 */
import type { AppSession, LogEntry } from '@durbun/protocol';
import type { IpsReport } from './crashReport';

export const DEDUPE_PID_WINDOW_MS = 60_000;
export const DEDUPE_BUNDLE_WINDOW_MS = 10_000;
/** Live rows are kept this long after they arrived (reports are read within a scan or two). */
const KEEP_MS = 30 * 60_000;
const MAX_ROWS = 300;

const SDK_CRASH = /^(?:Uncaught exception |Crash in previous launch: )/;
const PREVIOUS_LAUNCH = 'Crash in previous launch: ';
const TERMINATING = '*** Terminating app due to uncaught exception';

interface LiveCrash {
  id: number;
  deviceId: string;
  ts: number;
  pid?: number;
  bundleId?: string;
  claimed: boolean;
  arrivedAt: number;
}

export interface IosCrashIndexOptions {
  /** Device ids of this driver (lines of other devices are ignored). */
  owns(deviceId: string): boolean;
  getApps(): AppSession[];
  now?: () => number;
}

export class IosCrashIndex {
  private rows: LiveCrash[] = [];
  private readonly now: () => number;

  constructor(private readonly opts: IosCrashIndexOptions) {
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.rows.length;
  }

  /** Hub log tap: remembers live crash rows of this driver's devices (two field checks for any other line). */
  add(entries: readonly LogEntry[]): void {
    for (const e of entries) {
      if (e.kind !== 'crash' || e.level !== 'fatal' || e.origin === 'crash-report') continue;
      if (!this.opts.owns(e.deviceId)) continue;
      const row = this.liveRow(e);
      if (row) this.rows.push(row);
    }
    if (this.rows.length > MAX_ROWS) this.rows.splice(0, this.rows.length - MAX_ROWS);
  }

  /** Id of the live row `report` of `deviceId` duplicates (claimed, so it absorbs no other report). */
  claim(deviceId: string, report: IpsReport): number | undefined {
    const now = this.now();
    this.rows = this.rows.filter((r) => now - r.arrivedAt <= KEEP_MS);
    if (report.ts === undefined) return undefined;
    let best: LiveCrash | undefined;
    let bestScore = Infinity;
    for (const r of this.rows) {
      if (r.claimed || r.deviceId !== deviceId) continue;
      const dt = Math.abs(r.ts - report.ts);
      let score: number;
      if (report.pid !== undefined && r.pid === report.pid && dt <= DEDUPE_PID_WINDOW_MS) score = dt;
      else if (report.bundleId && r.bundleId === report.bundleId && dt <= DEDUPE_BUNDLE_WINDOW_MS) score = DEDUPE_PID_WINDOW_MS + dt;
      else continue;
      if (score < bestScore) {
        best = r;
        bestScore = score;
      }
    }
    if (!best) return undefined;
    best.claimed = true;
    return best.id;
  }

  private liveRow(e: LogEntry): LiveCrash | undefined {
    const base = { id: e.id, deviceId: e.deviceId, ts: e.ts, claimed: false, arrivedAt: this.now() };
    if (e.source === 'app') {
      if (e.tag !== 'crash' || !SDK_CRASH.test(e.message)) return undefined;
      const session = e.appId ? this.opts.getApps().find((a) => a.id === e.appId) : undefined;
      const bundleId = session?.app.id;
      const data = e.data as { previousLaunch?: unknown } | null | undefined;
      const previous = e.message.startsWith(PREVIOUS_LAUNCH) || (!!data && typeof data === 'object' && data.previousLaunch === true);
      // A previous-launch row comes from the next process: its session pid is not the crashed one.
      const pid = previous ? undefined : session?.app.pid;
      if (!bundleId && pid === undefined) return undefined;
      return { ...base, ...(pid !== undefined ? { pid } : {}), ...(bundleId ? { bundleId } : {}) };
    }
    if (e.source === 'device' && e.pid && e.message.includes(TERMINATING)) return { ...base, pid: e.pid };
    return undefined;
  }
}
