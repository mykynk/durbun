/**
 * `xcrun devicectl` (Xcode 15+) helpers. Results are read from `--json-output <file>` (works on every
 * devicectl version, unlike "-" for stdout) and errors are extracted from the JSON or stderr.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { InstalledApp } from '@durbun/protocol';
import { run } from '../exec';
import { XCRUN } from './simctl';

export interface DevicectlResult {
  ok: boolean;
  json?: Record<string, unknown>;
  error?: string;
  stdout: string;
  stderr: string;
}

let fileSeq = 0;

export async function devicectl(args: string[], timeoutMs = 60_000): Promise<DevicectlResult> {
  fileSeq += 1;
  const jsonFile = path.join(os.tmpdir(), `durbun-devicectl-${process.pid}-${Date.now()}-${fileSeq}.json`);
  const r = await run(XCRUN, ['devicectl', ...args, '--json-output', jsonFile], { timeoutMs });
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(await fs.promises.readFile(jsonFile, 'utf8')) as Record<string, unknown>;
  } catch {
    json = undefined;
  } finally {
    await fs.promises.rm(jsonFile, { force: true });
  }
  const outcome = (json?.info as Record<string, unknown> | undefined)?.outcome;
  const ok = r.ok && (outcome === undefined || outcome === 'success');
  return { ok, json, stdout: r.stdout, stderr: r.stderr, ...(ok ? {} : { error: devicectlError(json, r.stderr, r.error) }) };
}

/** Human error text from devicectl JSON (error.userInfo.NSLocalizedDescription) or stderr. */
export function devicectlError(json: Record<string, unknown> | undefined, stderr: string, spawnError?: string): string {
  const err = json?.error as Record<string, unknown> | undefined;
  const info = err?.userInfo as Record<string, unknown> | undefined;
  const desc = info?.NSLocalizedDescription as unknown;
  const pick = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { string?: unknown }).string === 'string'
      ? (v as { string: string }).string
      : undefined;
  const reason = pick(info?.NSLocalizedFailureReason) ?? pick(info?.NSLocalizedRecoverySuggestion);
  const main = pick(desc);
  if (main) return reason && !main.includes(reason) ? `${main} ${reason}` : main;
  const errLine = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^ERROR:/i.test(l) || /^error:/.test(l));
  if (errLine) return errLine.replace(/^ERROR:\s*/i, '');
  const last = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return spawnError ?? last ?? 'devicectl failed';
}

function result(json: Record<string, unknown> | undefined): Record<string, unknown> {
  const r = json?.result;
  return r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
}

export interface DevicectlApp {
  bundleIdentifier: string;
  name?: string;
  version?: string;
  url?: string;
  builtByDeveloper?: boolean;
  removable?: boolean;
  defaultApp?: boolean;
  hidden?: boolean;
}

export function parseDevicectlApps(json: Record<string, unknown> | undefined): DevicectlApp[] {
  const apps = result(json).apps;
  if (!Array.isArray(apps)) return [];
  const out: DevicectlApp[] = [];
  for (const a of apps as Array<Record<string, unknown>>) {
    if (typeof a?.bundleIdentifier !== 'string') continue;
    out.push({
      bundleIdentifier: a.bundleIdentifier,
      ...(typeof a.name === 'string' ? { name: a.name } : {}),
      ...(typeof a.version === 'string' ? { version: a.version } : typeof a.bundleVersion === 'string' ? { version: a.bundleVersion } : {}),
      ...(typeof a.url === 'string' ? { url: a.url } : {}),
      ...(typeof a.builtByDeveloper === 'boolean' ? { builtByDeveloper: a.builtByDeveloper } : {}),
      ...(typeof a.removable === 'boolean' ? { removable: a.removable } : {}),
      ...(typeof a.defaultApp === 'boolean' ? { defaultApp: a.defaultApp } : {}),
      ...(typeof a.hidden === 'boolean' ? { hidden: a.hidden } : {}),
    });
  }
  return out;
}

export function toInstalledApps(apps: DevicectlApp[]): InstalledApp[] {
  return apps
    .map((a) => {
      const app: InstalledApp = { id: a.bundleIdentifier };
      if (a.name) app.name = a.name;
      if (a.version) app.version = a.version;
      if (a.builtByDeveloper !== undefined) app.debuggable = a.builtByDeveloper;
      app.system = a.defaultApp === true || a.removable === false;
      return app;
    })
    .sort((x, y) => Number(x.system) - Number(y.system) || x.id.localeCompare(y.id));
}

export interface DevicectlProcess {
  pid: number;
  executable?: string;
}

export function parseDevicectlProcesses(json: Record<string, unknown> | undefined): DevicectlProcess[] {
  const list = result(json).runningProcesses;
  if (!Array.isArray(list)) return [];
  const out: DevicectlProcess[] = [];
  for (const p of list as Array<Record<string, unknown>>) {
    const pid = Number(p?.processIdentifier);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    out.push({ pid, ...(typeof p.executable === 'string' ? { executable: p.executable } : {}) });
  }
  return out;
}

/** Processes whose executable lives inside the app bundle URL. */
export function pidsForApp(processes: DevicectlProcess[], appUrl: string): number[] {
  const prefix = appUrl.endsWith('/') ? appUrl : `${appUrl}/`;
  const norm = (u: string) => u.replace(/^file:\/\/(\/private)?/, 'file://');
  const p = norm(prefix);
  return processes.filter((x) => x.executable && norm(x.executable).startsWith(p)).map((x) => x.pid);
}

export interface DevicectlDevice {
  udid: string;
  identifier?: string;
  name?: string;
  marketingName?: string;
  productType?: string;
  osVersion?: string;
  reality?: string;
  connectionState?: string;
}

/** `devicectl list devices` JSON (new `properties` layout and the deprecated one). */
export function parseDevicectlDevices(json: Record<string, unknown> | undefined): DevicectlDevice[] {
  const devices = result(json).devices;
  if (!Array.isArray(devices)) return [];
  const out: DevicectlDevice[] = [];
  for (const d of devices as Array<Record<string, any>>) {
    const props = (d?.properties ?? {}) as Record<string, any>;
    const hw = (props.hardware ?? d?.hardwareProperties ?? {}) as Record<string, any>;
    const dp = (d?.deviceProperties ?? {}) as Record<string, any>;
    const udid = hw.udid ?? d?.hardwareProperties?.udid;
    if (typeof udid !== 'string') continue;
    const sw = (props.software ?? {}) as Record<string, any>;
    const osVersion =
      (typeof sw.osVersionNumber?.stringValue === 'string' ? sw.osVersionNumber.stringValue : undefined) ??
      (typeof dp.osVersionNumber === 'string' ? dp.osVersionNumber : undefined);
    const name = props.state?.name ?? dp.name;
    out.push({
      udid,
      ...(typeof d.identifier === 'string' ? { identifier: d.identifier } : {}),
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof hw.marketingName === 'string' ? { marketingName: hw.marketingName } : {}),
      ...(typeof hw.productType === 'string' ? { productType: hw.productType } : {}),
      ...(osVersion ? { osVersion } : {}),
      ...(typeof hw.reality === 'string' ? { reality: hw.reality } : {}),
      ...(typeof props.connection?.state === 'string'
        ? { connectionState: props.connection.state }
        : typeof d.connectionProperties?.tunnelState === 'string'
          ? { connectionState: d.connectionProperties.tunnelState }
          : {}),
    });
  }
  return out;
}

export interface DevicectlCaps {
  available: boolean;
  version?: string;
  screenshot: boolean;
  screenRecord: boolean;
  openURL: boolean;
}

let capsCache: DevicectlCaps | undefined;

/** Which devicectl subcommands this Xcode has (cached). */
export async function probeDevicectlCaps(force = false): Promise<DevicectlCaps> {
  if (capsCache && !force) return capsCache;
  const v = await run(XCRUN, ['devicectl', '--version'], { timeoutMs: 15_000 });
  if (!v.ok) {
    capsCache = { available: false, screenshot: false, screenRecord: false, openURL: false };
    return capsCache;
  }
  const [cap, proc] = await Promise.all([
    run(XCRUN, ['devicectl', 'device', 'capture', '--help'], { timeoutMs: 15_000 }),
    run(XCRUN, ['devicectl', 'device', 'process', '--help'], { timeoutMs: 15_000 }),
  ]);
  const capText = `${cap.stdout}\n${cap.stderr}`;
  const procText = `${proc.stdout}\n${proc.stderr}`;
  capsCache = {
    available: true,
    version: v.stdout.trim().split('\n')[0],
    screenshot: /^\s*screenshot\b/m.test(capText),
    screenRecord: /^\s*screen-record\b/m.test(capText),
    openURL: /^\s*openURL\b/m.test(procText),
  };
  return capsCache;
}
