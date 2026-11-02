/**
 * Simulator apps are ordinary macOS processes: poll `ps -o %cpu=,rss=,time= -p <pid>` every 2 s
 * (source 'host'). CPU is computed from the cumulative CPU time delta (precise), falling back to
 * ps' decaying %cpu for the first sample.
 */
import type { HubSink, Logger } from '../../types';
import { run } from '../exec';
import { every } from '../shared/timing';
import { pidFromLaunchctl, simctl } from './simctl';

export const HOST_METRICS_INTERVAL_MS = 2000;

/** "111:33.59" / "1:02:03.45" / "2-01:02:03" → seconds. */
export function parsePsTime(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  let days = 0;
  let rest = t;
  const dash = t.indexOf('-');
  if (dash > 0) {
    days = Number(t.slice(0, dash));
    rest = t.slice(dash + 1);
  }
  const parts = rest.split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return undefined;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return days * 86_400 + secs;
}

export interface PsSample {
  cpuPct: number;
  rssKB: number;
  cpuSeconds?: number;
}

/** One line of `ps -o %cpu=,rss=,time=`. */
export function parsePsMetrics(text: string): PsSample | undefined {
  const line = text.split('\n').find((l) => l.trim());
  if (!line) return undefined;
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return undefined;
  const cpuPct = Number(parts[0]!.replace(',', '.'));
  const rssKB = Number(parts[1]);
  if (!Number.isFinite(cpuPct) || !Number.isFinite(rssKB)) return undefined;
  const cpuSeconds = parts[2] ? parsePsTime(parts[2]) : undefined;
  return { cpuPct, rssKB, ...(cpuSeconds !== undefined ? { cpuSeconds } : {}) };
}

/**
 * Find a simulator process on the host by name: executable basename, "<name>.app/" in the path, or
 * (bundle id) the UIKitApplication:<id> launchd job inside the simulator.
 */
export function findSimProcessInPs(psText: string, udid: string, name: string): number | undefined {
  let best: number | undefined;
  for (const line of psText.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[2]!;
    if (!cmd.includes(`/Devices/${udid}/`)) continue;
    const exe = cmd.split(' ')[0] ?? '';
    const base = exe.slice(exe.lastIndexOf('/') + 1);
    if (base === name || cmd.includes(`/${name}.app/`)) {
      const pid = Number(m[1]);
      if (best === undefined || pid > best) best = pid;
    }
  }
  return best;
}

export interface HostMetricsDeps {
  udid: string;
  deviceId: string;
  hub: HubSink;
  logger: Logger;
}

export class HostProcessMetrics {
  private cancel?: () => void;
  private pid?: number;
  private prev?: { cpuSeconds: number; at: number };
  private misses = 0;

  constructor(
    private readonly deps: HostMetricsDeps,
    readonly target: { pid?: number; processName?: string },
  ) {
    this.pid = target.pid;
  }

  start(): void {
    if (this.cancel) return;
    this.cancel = every(HOST_METRICS_INTERVAL_MS, () => this.tick(), this.deps.logger);
    void this.tick();
  }

  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
  }

  private async resolvePid(): Promise<number | undefined> {
    const name = this.target.processName;
    if (!name) return undefined;
    const ps = await run('/bin/ps', ['-axww', '-o', 'pid=,command='], { timeoutMs: 10_000, maxBuffer: 16 * 1024 * 1024 });
    const fromPs = ps.ok ? findSimProcessInPs(ps.stdout, this.deps.udid, name) : undefined;
    if (fromPs) return fromPs;
    const lc = await simctl(['spawn', this.deps.udid, 'launchctl', 'list'], { timeoutMs: 10_000 });
    return lc.ok ? pidFromLaunchctl(lc.stdout, name) : undefined;
  }

  private async tick(): Promise<void> {
    if (!this.cancel) return;
    if (!this.pid) {
      this.pid = await this.resolvePid();
      this.prev = undefined;
      if (!this.pid) return;
    }
    const pid = this.pid;
    const r = await run('/bin/ps', ['-o', '%cpu=,rss=,time=', '-p', String(pid)], { timeoutMs: 5000 });
    if (!this.cancel) return;
    const sample = r.ok ? parsePsMetrics(r.stdout) : undefined;
    if (!sample) {
      this.prev = undefined;
      this.misses += 1;
      if (this.target.processName) this.pid = undefined;
      else if (this.misses >= 5) this.stop();
      return;
    }
    this.misses = 0;
    const now = Date.now();
    let cpu = sample.cpuPct;
    if (sample.cpuSeconds !== undefined) {
      if (this.prev && now > this.prev.at && sample.cpuSeconds >= this.prev.cpuSeconds) {
        cpu = Math.round(((sample.cpuSeconds - this.prev.cpuSeconds) / ((now - this.prev.at) / 1000)) * 1000) / 10;
      }
      this.prev = { cpuSeconds: sample.cpuSeconds, at: now };
    }
    this.deps.hub.pushMetrics([
      {
        ts: now,
        deviceId: this.deps.deviceId,
        pid,
        source: 'host',
        cpu,
        memoryMB: Math.round((sample.rssKB / 1024) * 10) / 10,
      },
    ]);
  }
}
