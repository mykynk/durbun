/**
 * Simulator apps (SPEC §10.2): `xcrun simctl listapps <udid>` (OpenStep plist) → user apps with
 * IsDeveloperApp (→ install 'simulator', buildType 'debug' | 'release'); running pids from the host
 * process table (`ps -axww -o pid=,command=`): simulator apps are ordinary macOS processes whose
 * executable lives inside the app's bundle path under CoreSimulator/Devices/<udid>/.
 */
import { parse as parsePlist } from 'plist';
import { run } from '../exec';
import type { AppSource, InstalledIosApp } from './appTracker';
import { isThirdPartyBundle } from './crashReport';
import { simctl } from './simctl';

const pick = (...values: unknown[]): string | undefined => {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
};

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'YES' || v === 'true';

function fileUrlToPath(u: string): string {
  let p = u.replace(/^file:\/\//, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep */
  }
  return p.replace(/\/+$/, '');
}

/** User apps of one simulator from `simctl listapps` output. */
export function parseSimInstalledApps(text: string): InstalledIosApp[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let value: unknown;
  try {
    value = parsePlist(trimmed);
  } catch {
    return [];
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const out: InstalledIosApp[] = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const info = raw as Record<string, unknown>;
    const type = typeof info.ApplicationType === 'string' ? info.ApplicationType : 'User';
    const id = pick(info.CFBundleIdentifier) ?? key;
    if (type !== 'User' || !isThirdPartyBundle(id)) continue;
    const dev = truthy(info.IsDeveloperApp);
    const name = pick(info.CFBundleDisplayName, info.CFBundleName);
    const version = pick(info.CFBundleShortVersionString);
    const build = pick(info.CFBundleVersion);
    const executable = pick(info.CFBundleExecutable);
    const bundlePath = pick(info.Path) ?? (typeof info.Bundle === 'string' ? fileUrlToPath(info.Bundle) : undefined);
    out.push({
      id,
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
      ...(build ? { build } : {}),
      buildType: dev ? 'debug' : 'release',
      source: 'simulator',
      ...(executable ? { executable } : {}),
      ...(bundlePath ? { bundle: bundlePath } : {}),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const normPath = (p: string) => p.replace(/^\/private(?=\/)/, '');

/** Host `ps -axww -o pid=,command=` → pids per app whose executable lives inside its bundle path. */
export function simPidsFromPs(psText: string, apps: readonly InstalledIosApp[]): Map<string, number[]> {
  const prefixes = apps.filter((a) => a.bundle).map((a) => [a.id, `${normPath(a.bundle!)}/`] as const);
  const out = new Map<string, number[]>();
  if (!prefixes.length) return out;
  for (const line of psText.split('\n')) {
    const m = /^\s*(\d+)\s+(\/.*)$/.exec(line);
    if (!m) continue;
    const cmd = normPath(m[2]!);
    if (!cmd.includes('/CoreSimulator/Devices/')) continue;
    for (const [id, prefix] of prefixes) {
      if (!cmd.startsWith(prefix)) continue;
      const pid = Number(m[1]);
      const list = out.get(id) ?? [];
      list.push(pid);
      out.set(id, list);
      break;
    }
  }
  return out;
}

export function simAppSource(udid: string): AppSource {
  return {
    async listInstalled() {
      const r = await simctl(['listapps', udid], { timeoutMs: 30_000, maxBuffer: 64 * 1024 * 1024 });
      return r.ok ? parseSimInstalledApps(r.stdout) : null;
    },
    async listRunning(apps) {
      const r = await run('/bin/ps', ['-axww', '-o', 'pid=,command='], { timeoutMs: 10_000, maxBuffer: 32 * 1024 * 1024 });
      return r.ok ? simPidsFromPs(r.stdout, apps) : null;
    },
  };
}
