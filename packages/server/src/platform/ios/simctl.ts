/** `xcrun simctl` helpers and pure parsers for its output. */
import type { DevicePlatform, InstalledApp } from '@durbun/protocol';
import { parse as parsePlist } from 'plist';
import { run, type RunOptions, type RunResult } from '../exec';

export const XCRUN = '/usr/bin/xcrun';

export function simctl(args: string[], opts?: RunOptions): Promise<RunResult<string>> {
  return run(XCRUN, ['simctl', ...args], { timeoutMs: 30_000, ...opts });
}

export interface BootedSimulator {
  udid: string;
  name: string;
  runtime: string;
  platform: DevicePlatform;
  /** e.g. "27.2" */
  osVersion?: string;
  /** e.g. "iPhone 17 Pro" (from the device type identifier). */
  model?: string;
  deviceTypeIdentifier?: string;
}

/** "com.apple.CoreSimulator.SimRuntime.iOS-27-2" → { platform: 'ios', osVersion: '27.2', os: 'iOS' }. */
export function parseRuntimeId(runtime: string): { platform: DevicePlatform; os?: string; osVersion?: string } {
  const m = /SimRuntime\.(iOS|watchOS|tvOS|xrOS|visionOS)-(\d+)-(\d+)(?:-(\d+)(?![A-Za-z\d]))?/.exec(runtime);
  if (!m) return { platform: runtime.includes('iOS') ? 'ios' : 'other' };
  const version = m[4] !== undefined ? `${m[2]}.${m[3]}.${m[4]}` : `${m[2]}.${m[3]}`;
  return { platform: m[1] === 'iOS' ? 'ios' : 'other', os: m[1], osVersion: version };
}

/** "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro" → "iPhone 17 Pro". */
export function modelFromDeviceType(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const last = id.split('.').pop();
  if (!last) return undefined;
  return last.replace(/-/g, ' ').replace(/\s+/g, ' ').trim() || undefined;
}

/** `xcrun simctl list devices booted -j` → booted simulators. */
export function parseBootedDevices(json: string): BootedSimulator[] {
  let data: { devices?: Record<string, Array<Record<string, unknown>>> };
  try {
    data = JSON.parse(json) as typeof data;
  } catch {
    return [];
  }
  const out: BootedSimulator[] = [];
  for (const [runtime, list] of Object.entries(data.devices ?? {})) {
    if (!Array.isArray(list)) continue;
    const rt = parseRuntimeId(runtime);
    for (const d of list) {
      if (d.state !== 'Booted' || typeof d.udid !== 'string') continue;
      const deviceType = typeof d.deviceTypeIdentifier === 'string' ? d.deviceTypeIdentifier : undefined;
      out.push({
        udid: d.udid,
        name: typeof d.name === 'string' ? d.name : d.udid,
        runtime,
        platform: rt.platform,
        ...(rt.osVersion ? { osVersion: rt.osVersion } : {}),
        ...(modelFromDeviceType(deviceType) ? { model: modelFromDeviceType(deviceType) } : {}),
        ...(deviceType ? { deviceTypeIdentifier: deviceType } : {}),
      });
    }
  }
  return out;
}

/** `xcrun simctl listapps <udid>` (OpenStep or XML plist) → installed apps. */
export function parseListApps(text: string, includeSystem: boolean): InstalledApp[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let value: unknown;
  try {
    value = parsePlist(trimmed);
  } catch {
    return [];
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const apps: InstalledApp[] = [];
  for (const [bundleId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const info = raw as Record<string, unknown>;
    const type = typeof info.ApplicationType === 'string' ? info.ApplicationType : 'User';
    const system = type !== 'User';
    if (system && !includeSystem) continue;
    const name = pickString(info.CFBundleDisplayName, info.CFBundleName, info.CFBundleExecutable);
    const version = pickString(info.CFBundleShortVersionString, info.CFBundleVersion);
    const id = pickString(info.CFBundleIdentifier) ?? bundleId;
    const dev = info.IsDeveloperApp;
    const app: InstalledApp = { id, ...(name ? { name } : {}), ...(version ? { version } : {}), system };
    if (dev !== undefined) app.debuggable = dev === true || dev === 1 || dev === '1' || dev === 'YES';
    apps.push(app);
  }
  return apps.sort((a, b) => Number(a.system) - Number(b.system) || a.id.localeCompare(b.id));
}

function pickString(...values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

/** iOS Dynamic Type categories with their body-text scale relative to "large" (17 pt). */
export const CONTENT_SIZES: ReadonlyArray<[name: string, scale: number]> = [
  ['extra-small', 14 / 17],
  ['small', 15 / 17],
  ['medium', 16 / 17],
  ['large', 1],
  ['extra-large', 19 / 17],
  ['extra-extra-large', 21 / 17],
  ['extra-extra-extra-large', 23 / 17],
  ['accessibility-medium', 28 / 17],
  ['accessibility-large', 33 / 17],
  ['accessibility-extra-large', 40 / 17],
  ['accessibility-extra-extra-large', 47 / 17],
  ['accessibility-extra-extra-extra-large', 53 / 17],
];

/** Font scale (1 = default) → nearest content size category. */
export function contentSizeForScale(scale: number): string {
  let best = CONTENT_SIZES[3]!;
  let bestDiff = Infinity;
  for (const entry of CONTENT_SIZES) {
    const diff = Math.abs(Math.log(entry[1]) - Math.log(scale));
    if (diff < bestDiff) {
      best = entry;
      bestDiff = diff;
    }
  }
  return best[0];
}

/** `launchctl list` inside a simulator → pid of UIKitApplication:<bundleId>. */
export function pidFromLaunchctl(text: string, bundleId: string): number | undefined {
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const label = parts.slice(2).join(' ');
    if (label.startsWith(`UIKitApplication:${bundleId}[`) || label === `UIKitApplication:${bundleId}`) {
      const pid = Number(parts[0]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  }
  return undefined;
}
