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

/** Injectable devicectl invocation (tests pass a fake). */
export type DevicectlRunner = (args: string[], timeoutMs?: number) => Promise<DevicectlResult>;

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
  /** CFBundleShortVersionString (falls back to bundleVersion when absent). */
  version?: string;
  /** CFBundleVersion (the build number). */
  bundleVersion?: string;
  url?: string;
  builtByDeveloper?: boolean;
  removable?: boolean;
  defaultApp?: boolean;
  hidden?: boolean;
  internalApp?: boolean;
  appClip?: boolean;
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
      ...(typeof a.bundleVersion === 'string' ? { bundleVersion: a.bundleVersion } : {}),
      ...(typeof a.url === 'string' ? { url: a.url } : {}),
      ...(typeof a.internalApp === 'boolean' ? { internalApp: a.internalApp } : {}),
      ...(typeof a.appClip === 'boolean' ? { appClip: a.appClip } : {}),
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
  /** Developer Mode on the device ('enabled' / 'disabled'); absent when devicectl does not say. */
  developerMode?: string;
}

/**
 * Developer Mode from `list devices`: `properties.state.developerModeStatus` is an enum object
 * (`{"enabled": {"mode": 1}}`), the deprecated `deviceProperties.developerModeStatus` a plain string.
 */
function developerModeOf(state: unknown, deprecated: unknown): string | undefined {
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const key = Object.keys(state)[0];
    if (key) return key;
  }
  if (typeof state === 'string' && state) return state;
  return typeof deprecated === 'string' && deprecated ? deprecated : undefined;
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
    const developerMode = developerModeOf(props.state?.developerModeStatus, dp.developerModeStatus);
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
      ...(developerMode ? { developerMode } : {}),
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

/**
 * devicectl dates: ISO strings in current fields ("2026-11-01T23:05:19.000Z"), seconds since
 * 2001-01-01 (Foundation reference date) in deprecated ones (815267119). → epoch ms.
 */
export function devicectlDate(v: unknown): number | undefined {
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    if (v > 1e11) return v; // already ms
    if (v < 1.2e9) return (v + 978_307_200) * 1000; // reference date (2001) seconds
    return v * 1000;
  }
  return undefined;
}

export interface DevicectlFile {
  name: string;
  /** Path inside the domain (what `copy from --source` takes). */
  relativePath: string;
  isDirectory: boolean;
  size?: number;
  modified?: number;
  /** Report type from the file's `bug_type` extended attribute ("309" crash, "298" Jetsam…), when set. */
  bugType?: string;
}

/**
 * `devicectl device info files --domain-type <d>` JSON: result.files[] = {name, relativePath,
 * resources: {isDirectory, …}, metadata: {lastModDate, size, extendedAttributes: {bug_type, LogType, …}}}.
 * Seen on devicectl 651.32 / iOS 27.2: `name` is the path inside the domain like `relativePath`
 * ("Retired/Runner-2026-11-02-095019.ips"); report files carry `bug_type` / `LogType` ("309_Runner").
 * The nesting is read leniently.
 */
export function parseDevicectlFiles(json: Record<string, unknown> | undefined): DevicectlFile[] {
  const r = result(json);
  const list = Array.isArray(r.files) ? r.files : Array.isArray(r.items) ? r.items : [];
  const out: DevicectlFile[] = [];
  for (const raw of list as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as Record<string, unknown>;
    const scopes = [f, f.metadata, f.resources, f.attributes].filter(
      (x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x),
    );
    const pick = (key: string): unknown => {
      for (const s of scopes) if (s[key] !== undefined) return s[key];
      return undefined;
    };
    const rel = typeof f.relativePath === 'string' ? f.relativePath : typeof f.path === 'string' ? f.path : undefined;
    const name = typeof f.name === 'string' && f.name ? f.name : rel ? rel.split('/').pop() : undefined;
    if (!name) continue;
    const dirFlag = pick('isDirectory');
    const type = pick('type') ?? pick('fileType');
    const isDirectory = dirFlag === true || type === 'directory' || type === 'NSFileTypeDirectory';
    const size = pick('size');
    const modified = devicectlDate(pick('lastModDate') ?? pick('lastModificationDate') ?? pick('modificationDate') ?? pick('creationDate'));
    const xattrs = pick('extendedAttributes');
    const rawBugType = xattrs && typeof xattrs === 'object' ? (xattrs as Record<string, unknown>).bug_type : undefined;
    const bugType = typeof rawBugType === 'string' || typeof rawBugType === 'number' ? String(rawBugType).trim() : '';
    out.push({
      name,
      relativePath: (rel ?? name).replace(/^\/+/, ''),
      isDirectory,
      ...(typeof size === 'number' ? { size } : {}),
      ...(modified !== undefined ? { modified } : {}),
      ...(bugType ? { bugType } : {}),
    });
  }
  return out;
}
