/**
 * Per-VM state that must outlive a single WebSocket connection: re-attaching to the same VM (reconnect
 * after DDS took over, manual detach + attach) reuses the same app session on the server, so requests and
 * replayed log history must not be delivered twice.
 */
import { HttpProfileTracker } from './httpProfile';

/** Remembers the newest delivered event per stream so DDS history replays are not delivered twice. */
export class ReplayFilter {
  private readonly streams = new Map<string, { lastTs: number; keys: Set<string> }>();

  /** Record a delivered event. */
  mark(streamId: string, ts: unknown, key: string): void {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return;
    const s = this.streams.get(streamId);
    if (!s || ts > s.lastTs) {
      this.streams.set(streamId, { lastTs: ts, keys: new Set([key]) });
    } else if (ts === s.lastTs && s.keys.size < 4096) {
      s.keys.add(key);
    }
  }

  /**
   * Whether a replayed event was already delivered. Replays only contain events of the time we were
   * connected (or later), so anything older than the newest delivered event was seen live.
   */
  seen(streamId: string, ts: unknown, key: string): boolean {
    const s = this.streams.get(streamId);
    if (!s || typeof ts !== 'number' || !Number.isFinite(ts)) return false;
    if (ts < s.lastTs) return true;
    if (ts === s.lastTs) return s.keys.has(key);
    return false;
  }
}

export interface VmPersistentState {
  http: HttpProfileTracker;
  replay: ReplayFilter;
  /** Isolates in which Dürbün (not another tool) turned HTTP timeline logging on. */
  httpEnabledByUs: Set<string>;
}

/**
 * The VM computes `getVM().startTime` as "now − uptime" on every call, so it jitters by a millisecond or
 * two (observed through DDS on Dart 3.10). VM identity is therefore (pid, startTime ± tolerance).
 */
export const VM_START_TOLERANCE_MS = 2000;

export function sameVmProcess(a: { pid: number; startTime: number }, b: { pid: number; startTime: number }): boolean {
  return a.pid === b.pid && Math.abs(a.startTime - b.startTime) <= VM_START_TOLERANCE_MS;
}

interface StoredState {
  pid: number;
  startTime: number;
  state: VmPersistentState;
}

export class VmStateStore {
  private readonly entries: StoredState[] = [];

  constructor(private readonly capacity = 16) {}

  /** State of a VM process; `startTime` is the canonical (first seen) start time to build stable keys from. */
  resolve(pid: number, startTime: number): { startTime: number; state: VmPersistentState } {
    const idx = this.entries.findIndex((e) => sameVmProcess(e, { pid, startTime }));
    if (idx >= 0) {
      const [found] = this.entries.splice(idx, 1);
      this.entries.push(found!);
      return { startTime: found!.startTime, state: found!.state };
    }
    const created: StoredState = {
      pid,
      startTime,
      state: { http: new HttpProfileTracker(), replay: new ReplayFilter(), httpEnabledByUs: new Set() },
    };
    this.entries.push(created);
    while (this.entries.length > this.capacity) this.entries.shift();
    return { startTime, state: created.state };
  }
}
