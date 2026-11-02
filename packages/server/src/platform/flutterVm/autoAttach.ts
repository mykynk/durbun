/**
 * Auto-attach helpers: spot "The Dart VM service is listening on …" announcements in device logs
 * (logcat tag `flutter`, iOS `flutter: …` lines, old "Observatory listening on …") and decide how to
 * reach them.
 */
import type { LogEntry } from '@durbun/protocol';
import { isLoopbackHost, parseVmServiceAnnouncement } from './url';

export interface Announcement {
  deviceId: string;
  /** URL as announced (device-side address). */
  url: string;
  pid?: number;
  process?: string;
  /** Log timestamp (device clock). */
  ts: number;
}

/** Devices whose VM services are reachable from the desktop (not demo/import/LAN/desktop). */
export function isAutoAttachDevice(deviceId: string): boolean {
  return deviceId.startsWith('android:') || deviceId.startsWith('ios:') || deviceId.startsWith('ios-sim:');
}

/**
 * Device-local URLs (loopback, or the any-address when the service binds all interfaces) of Android /
 * physical iOS devices need a port forward; simulators share the host network.
 */
export function needsPortForward(deviceId: string, host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  const local = isLoopbackHost(h) || h === '0.0.0.0' || h === '::';
  return (deviceId.startsWith('android:') || deviceId.startsWith('ios:')) && local;
}

export function processKeyOf(a: { pid?: number; process?: string }): string {
  return a.process?.trim() || (a.pid ? `pid:${a.pid}` : 'unknown');
}

/** Old lines (logcat replays its buffer when a device reconnects) are retried quietly. */
export function isFreshAnnouncement(ts: number, now = Date.now(), maxAgeMs = 120_000): boolean {
  return Number.isFinite(ts) && Math.abs(now - ts) <= maxAgeMs;
}

/** (device, pid) → process name, learned from device log lines (bounded). */
export class ProcessNameCache {
  private readonly map = new Map<string, string>();

  constructor(private readonly capacity = 4000) {}

  set(deviceId: string, pid: number, name: string): void {
    const key = `${deviceId}|${pid}`;
    if (this.map.get(key) === name) return;
    this.map.delete(key);
    this.map.set(key, name);
    if (this.map.size > this.capacity) {
      let drop = Math.ceil(this.capacity / 4);
      for (const k of this.map.keys()) {
        if (drop-- <= 0) break;
        this.map.delete(k);
      }
    }
  }

  get(deviceId: string | undefined, pid: number | undefined): string | undefined {
    if (!deviceId || !pid) return undefined;
    return this.map.get(`${deviceId}|${pid}`);
  }
}

/**
 * Scan a log batch: remember pid → process names and collect VM service announcements, keeping only the
 * last one per (device, process) — a restarted app announces a new URL and the old one is dead.
 */
export function collectAnnouncements(entries: readonly LogEntry[], cache?: ProcessNameCache): Announcement[] {
  const byKey = new Map<string, Announcement>();
  for (const e of entries) {
    if (!e) continue;
    if (cache && e.pid && e.process) cache.set(e.deviceId, e.pid, e.process);
    // Only the device's own log (logcat / syslog / os_log) announces its VM service; app and system lines
    // (including our own captured stdout) must not trigger attaches.
    if (e.source !== 'device' || typeof e.message !== 'string') continue;
    const url = parseVmServiceAnnouncement(e.message);
    if (!url) continue;
    const a: Announcement = {
      deviceId: e.deviceId,
      url,
      ts: e.ts,
      ...(e.pid ? { pid: e.pid } : {}),
    };
    const process = e.process ?? cache?.get(e.deviceId, e.pid);
    if (process) a.process = process;
    const key = `${a.deviceId}|${processKeyOf(a)}`;
    byKey.delete(key);
    byKey.set(key, a);
  }
  return [...byKey.values()];
}
