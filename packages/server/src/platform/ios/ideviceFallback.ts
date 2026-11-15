/**
 * Installed apps and crash reports of a physical iPhone without devicectl — no Xcode 15+, an iPhone before
 * iOS 17, or (expected, not yet tried on a device) Developer Mode off — through libimobiledevice's lockdown
 * services, which any paired device offers:
 *   ideviceinstaller -u <udid> -l -o xml        installation_proxy Browse of the user apps as an XML plist
 *                                                 (1.1.x syntax; newer releases take `list -o xml`, tried next)
 *   idevicecrashreport -u <udid> -k <dir>       com.apple.crashreportcopymobile: copies the crash folder
 *                                                 (the same folder as devicectl's systemCrashLogs domain)
 * `-k` keeps the reports on the device: without it idevicecrashreport MOVES them (deletes the device's copy).
 * `-n` is added for an iPhone that is connected over Wi-Fi only.
 * The command lines and attributes follow the tools' documentation and source; they have not been run
 * against a device by these tests. Running processes are not available this way (no developer services),
 * so the app tracker keeps learning pids from the log, as before its first process listing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parsePlist } from 'plist';
import type { Logger } from '../../types';
import type { RunResult } from '../exec';
import type { AppSource, InstalledIosApp, UnlistedAppProcess } from './appTracker';
import { crashFileDate, isThirdPartyBundle, parseIpsHeader } from './crashReport';
import type { CrashSource } from './deviceCrashes';
import type { DevicectlFile } from './devicectl';

export type IdeviceFallbackTool = 'idevicecrashreport' | 'ideviceinstaller';
export type IdeviceRunner = (tool: IdeviceFallbackTool, args: string[], timeoutMs: number) => Promise<RunResult>;

/** Where a reader of an iPhone gets its data (the reader detail and the logs say it). */
export const VIA_IDEVICE_CRASHREPORT = 'idevicecrashreport';
export const VIA_IDEVICE_INSTALLER = 'ideviceinstaller';

/** The crash folder is copied whole each time: not more often than this. */
export const IDEVICE_CRASH_COPY_MIN_MS = 5 * 60_000;

const errorOf = (r: RunResult): string =>
  r.error ?? (r.stderr.trim() || r.stdout.trim()).split('\n').find((l) => l.trim())?.trim() ?? `exit code ${r.code}`;

/* ───────────── installed apps ───────────── */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Signing identities of development builds ("Apple Development: …", older "iPhone Developer: …"). */
const DEVELOPMENT_SIGNER = /^(Apple Development|iPhone Developer)\b/;

/**
 * installation_proxy Browse entries (the `-o xml` plist: an array of app dictionaries) → installed third-party
 * apps. A development-signed build (`get-task-allow` entitlement, or a development signing identity) counts as
 * a developer app ('xcode', debug); everything else as 'store-or-testflight' like devicectl's non-developer
 * apps. Null when the text is not such a plist.
 */
export function parseInstallerApps(text: string): InstalledIosApp[] | null {
  const start = text.indexOf('<?xml');
  if (start === -1) return null;
  let value: unknown;
  try {
    value = parsePlist(text.slice(start));
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const out: InstalledIosApp[] = [];
  for (const a of value) {
    if (!isObj(a)) continue;
    const id = str(a.CFBundleIdentifier);
    if (!isThirdPartyBundle(id)) continue;
    const type = str(a.ApplicationType);
    if (type && type !== 'User') continue;
    const entitlements = isObj(a.Entitlements) ? a.Entitlements : undefined;
    const signer = str(a.SignerIdentity);
    const dev = entitlements?.['get-task-allow'] === true || (!!signer && DEVELOPMENT_SIGNER.test(signer));
    const name = str(a.CFBundleDisplayName) ?? str(a.CFBundleName);
    const version = str(a.CFBundleShortVersionString);
    const build = str(a.CFBundleVersion);
    const executable = str(a.CFBundleExecutable);
    const bundlePath = str(a.Path);
    out.push({
      id,
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
      ...(build ? { build } : {}),
      buildType: dev ? 'debug' : 'release',
      source: dev ? 'xcode' : 'store-or-testflight',
      ...(executable ? { executable } : {}),
      // Same form as devicectl's bundle URLs (appContainerOf reads both).
      ...(bundlePath ? { bundle: `file://${bundlePath.replace(/\/*$/, '/')}` } : {}),
    });
  }
  return out.sort((x, y) => x.id.localeCompare(y.id));
}

export interface IdeviceTarget {
  udid: string;
  run: IdeviceRunner;
  /** The iPhone is reachable over Wi-Fi only (the tools then need `-n`). */
  networkOnly: () => boolean;
  logger: Logger;
}

const deviceArgs = (t: IdeviceTarget): string[] => ['-u', t.udid, ...(t.networkOnly() ? ['-n'] : [])];

/** Installed apps through ideviceinstaller; no running-process listing (null: the log tells the pids). */
export function ideviceinstallerAppSource(t: IdeviceTarget): AppSource & { readonly via: string } {
  let syntax: 'legacy' | 'command' | undefined;
  const attempt = async (which: 'legacy' | 'command') => {
    const args = [...deviceArgs(t), ...(which === 'legacy' ? ['-l', '-o', 'xml'] : ['list', '-o', 'xml'])];
    const r = await t.run('ideviceinstaller', args, 60_000);
    const apps = r.ok ? parseInstallerApps(r.stdout) : null;
    if (!apps) t.logger.debug(`ideviceinstaller ${args.join(' ')}: ${r.ok ? 'no app plist in the output' : errorOf(r)}`);
    return apps;
  };
  return {
    via: VIA_IDEVICE_INSTALLER,
    async listInstalled() {
      if (syntax) return attempt(syntax);
      for (const which of ['legacy', 'command'] as const) {
        const apps = await attempt(which);
        if (apps) {
          syntax = which;
          return apps;
        }
      }
      return null;
    },
    listRunning: async () => null,
  };
}

/**
 * The first source whose listing works (devicectl, then ideviceinstaller). While on the fallback the primary is
 * retried every `retryEvery` listings. Running processes come from the active source.
 */
export function fallbackAppSource(primary: AppSource | undefined, fallback: AppSource | undefined, retryEvery = 3): AppSource | undefined {
  if (!primary || !fallback) return primary ?? fallback;
  let active = primary;
  let sinceSwitch = 0;
  const current = () => active;
  // The optional methods exist only while the active source has them (the tracker checks their presence).
  return {
    get runningNames() {
      const a = current();
      return a.runningNames ? () => a.runningNames!() : undefined;
    },
    get unlistedApps() {
      const a = current();
      return a.unlistedApps ? (): ReadonlyMap<number, UnlistedAppProcess> => a.unlistedApps!() : undefined;
    },
    get systemNames() {
      const a = current();
      return a.systemNames ? () => a.systemNames!() : undefined;
    },
    async listInstalled() {
      if (active === fallback && ++sinceSwitch < retryEvery) return fallback.listInstalled();
      const apps = await primary.listInstalled();
      if (apps) {
        active = primary;
        return apps;
      }
      const other = await fallback.listInstalled();
      if (!other) {
        active = primary;
        return null;
      }
      active = fallback;
      sinceSwitch = 0;
      return other;
    },
    listRunning: (apps) => active.listRunning(apps),
  };
}

/* ───────────── crash reports ───────────── */

export interface IdeviceCrashSourceOptions extends IdeviceTarget {
  /** Local mirror of the device's crash folder (outside the served copy folder). */
  mirrorDir: string;
  now?: () => number;
  minCopyIntervalMs?: number;
}

/** First line of a file (the .ips JSON header), at most 4 KB. */
async function firstLine(file: string): Promise<string> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const nl = text.indexOf('\n');
    return nl === -1 ? text : text.slice(0, nl);
  } finally {
    await fh.close();
  }
}

/** Files under `root` as devicectl lists them: posix paths inside the folder, bug_type from the .ips header. */
export async function listCrashMirror(root: string): Promise<DevicectlFile[]> {
  const out: DevicectlFile[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, relPath, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const st = await fs.promises.stat(full).catch(() => undefined);
      if (!st) continue;
      let bugType: string | undefined;
      if (e.name.toLowerCase().endsWith('.ips')) {
        const header = parseIpsHeader(await firstLine(full).catch(() => ''));
        const b = header?.bug_type;
        if (typeof b === 'string' || typeof b === 'number') bugType = String(b);
      }
      out.push({
        name: relPath,
        relativePath: relPath,
        isDirectory: false,
        size: st.size,
        // The name carries the report time; the copy's mtime is when it was copied.
        modified: crashFileDate(e.name) ?? st.mtimeMs,
        ...(bugType ? { bugType } : {}),
      });
    }
  };
  await walk(root, '', 0);
  return out;
}

/**
 * The device's crash folder through idevicecrashreport: one copy of the whole folder into `mirrorDir` (at most
 * every `minCopyIntervalMs`, in between the last copy is listed again), then the watcher picks files from it.
 */
export function ideviceCrashSource(o: IdeviceCrashSourceOptions): CrashSource {
  const now = o.now ?? Date.now;
  let lastCopy: number | undefined;
  let cleared = false;
  return {
    via: VIA_IDEVICE_CRASHREPORT,
    async list() {
      if (lastCopy === undefined || now() - lastCopy >= (o.minCopyIntervalMs ?? IDEVICE_CRASH_COPY_MIN_MS)) {
        try {
          // A mirror left by an earlier session would only grow: start empty once per session.
          if (!cleared) await fs.promises.rm(o.mirrorDir, { recursive: true, force: true });
          cleared = true;
          await fs.promises.mkdir(o.mirrorDir, { recursive: true });
        } catch (e) {
          return { ok: false, error: `cannot create ${o.mirrorDir}: ${(e as Error).message}` };
        }
        // -k: copy, never move (without it the reports are deleted from the device).
        const r = await o.run('idevicecrashreport', [...deviceArgs(o), '-k', o.mirrorDir], 180_000);
        if (!r.ok) return { ok: false, error: errorOf(r) };
        lastCopy = now();
      }
      return { ok: true, files: await listCrashMirror(o.mirrorDir) };
    },
    async copy(file, dest) {
      const src = path.join(o.mirrorDir, ...file.relativePath.split('/'));
      if (path.relative(o.mirrorDir, src).startsWith('..')) return { ok: false, error: 'outside the mirror' };
      try {
        await fs.promises.copyFile(src, dest);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  };
}

/** `<tempDir>/crash-mirror/<udid>`: not under the served `<tempDir>/crash/` folder. */
export function crashMirrorDir(tempDir: string, udid: string): string {
  const safe = udid.replace(/[^A-Za-z0-9-]+/g, '').replace(/^-+/, '').slice(0, 100);
  return path.join(tempDir, 'crash-mirror', safe || 'device');
}
