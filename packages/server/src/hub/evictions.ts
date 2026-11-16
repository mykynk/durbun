/**
 * Counts of what the store limits deleted (StoreEvictions on the wire): totals, per device, per app session and
 * per device process, so the UI can tell each scope that older lines or requests are gone and why. The keyed
 * maps are bounded (oldest keys go first); a clear takes its scope out.
 */
import type { EvictedCounts, LogEntry, NetworkEntry, StoreEvictions } from '@durbun/protocol';

/** Keys kept per map (app sessions pile up over hot restarts; process names on a busy device). */
export const MAX_EVICTION_KEYS = 2_000;

const processKey = (deviceId: string, process: string) => `${deviceId}|${process}`;

function bump(map: Map<string, EvictedCounts>, key: string, field: keyof EvictedCounts): void {
  let c = map.get(key);
  if (!c) {
    c = { logs: 0, requests: 0 };
    map.set(key, c);
    if (map.size > MAX_EVICTION_KEYS) map.delete(map.keys().next().value!);
  }
  c[field]++;
}

export class EvictionCounter {
  private logs = 0;
  private logsByBytes = 0;
  private requests = 0;
  private bodies = 0;
  private lastLogTs: number | undefined;
  private lastRequestTs: number | undefined;
  private byDevice = new Map<string, EvictedCounts>();
  private byApp = new Map<string, EvictedCounts>();
  private byProcess = new Map<string, number>();
  /** Bumped on every change; `takeIfChanged` reports a change once. */
  private revision = 0;
  private reported = 0;

  log(e: LogEntry, byBytes: boolean): void {
    this.logs++;
    if (byBytes) this.logsByBytes++;
    if (this.lastLogTs === undefined || e.ts > this.lastLogTs) this.lastLogTs = e.ts;
    bump(this.byDevice, e.deviceId, 'logs');
    // Lines without a session: by process; Dürbün's own device lines (connection, log stream, markers) under ''.
    const named = e.code?.startsWith('process.') && typeof e.params?.process === 'string' ? e.params.process : '';
    const proc = e.process ?? (e.source === 'system' ? named : undefined);
    if (e.appId) bump(this.byApp, e.appId, 'logs');
    else if (proc !== undefined) {
      const key = processKey(e.deviceId, proc);
      this.byProcess.set(key, (this.byProcess.get(key) ?? 0) + 1);
      if (this.byProcess.size > MAX_EVICTION_KEYS) this.byProcess.delete(this.byProcess.keys().next().value!);
    }
    this.revision++;
  }

  request(e: NetworkEntry): void {
    this.requests++;
    if (this.lastRequestTs === undefined || e.startTs > this.lastRequestTs) this.lastRequestTs = e.startTs;
    bump(this.byDevice, e.deviceId, 'requests');
    if (e.appId) bump(this.byApp, e.appId, 'requests');
    this.revision++;
  }

  body(): void {
    this.bodies++;
    this.revision++;
  }

  /** Something outside the counts changed (the oldest held line after a new limit). */
  touch(): void {
    this.revision++;
  }

  /** An unscoped clear: the counts of what it cleared start again. */
  reset(logs = true, requests = true): void {
    if (logs) {
      this.logs = 0;
      this.logsByBytes = 0;
      this.lastLogTs = undefined;
      this.byProcess = new Map();
    }
    if (requests) {
      this.requests = 0;
      this.bodies = 0;
      this.lastRequestTs = undefined;
    }
    for (const map of [this.byDevice, this.byApp]) {
      for (const [key, c] of [...map]) {
        if (logs) c.logs = 0;
        if (requests) c.requests = 0;
        if (c.logs === 0 && c.requests === 0) map.delete(key);
      }
    }
    this.revision++;
  }

  /** A device's clear: its counts (and those of its sessions) leave the totals. */
  forgetDevice(deviceId: string, sessionIds: Iterable<string>): void {
    const c = this.byDevice.get(deviceId);
    if (c) {
      this.logs = Math.max(0, this.logs - c.logs);
      this.requests = Math.max(0, this.requests - c.requests);
      this.logsByBytes = Math.min(this.logsByBytes, this.logs);
      this.byDevice.delete(deviceId);
    }
    for (const id of sessionIds) this.byApp.delete(id);
    const prefix = `${deviceId}|`;
    for (const key of [...this.byProcess.keys()]) if (key.startsWith(prefix)) this.byProcess.delete(key);
    this.revision++;
  }

  /** An app's clear: its sessions' and processes' counts go (the device's totals stay: other apps' lines went too). */
  forgetApp(deviceId: string, sessionIds: Iterable<string>, ownsProcess?: (name: string) => boolean): void {
    for (const id of sessionIds) this.byApp.delete(id);
    if (ownsProcess) {
      const prefix = `${deviceId}|`;
      for (const key of [...this.byProcess.keys()]) if (key.startsWith(prefix) && ownsProcess(key.slice(prefix.length))) this.byProcess.delete(key);
    }
    this.revision++;
  }

  snapshot(oldestLogId: number): StoreEvictions {
    const out: StoreEvictions = {
      logs: this.logs,
      logsByBytes: this.logsByBytes,
      requests: this.requests,
      bodies: this.bodies,
      oldestLogId,
      byDevice: Object.fromEntries([...this.byDevice].map(([k, v]) => [k, { ...v }])),
      byApp: Object.fromEntries([...this.byApp].map(([k, v]) => [k, { ...v }])),
      byProcess: Object.fromEntries(this.byProcess),
    };
    if (this.lastLogTs !== undefined) out.lastEvictedLogTs = this.lastLogTs;
    if (this.lastRequestTs !== undefined) out.lastEvictedRequestTs = this.lastRequestTs;
    return out;
  }

  /** True once after each change (the batcher attaches the counts to the next batch only then). */
  takeIfChanged(): boolean {
    if (this.reported === this.revision) return false;
    this.reported = this.revision;
    return true;
  }

}
