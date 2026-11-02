/**
 * External tool resolution (SPEC §5.5 "Tool resolution").
 *
 *  adb:            settings.adbPath → $ANDROID_HOME|$ANDROID_SDK_ROOT/platform-tools/adb →
 *                  ~/Library/Android/sdk/platform-tools/adb → adb on PATH
 *  idevicesyslog / idevicescreenshot / iproxy:
 *                  settings.idevicesyslogPath (siblings for the other tools) → PATH (+ /opt/homebrew/bin,
 *                  /usr/local/bin) → Flutter's cache (<flutter>/bin/cache/artifacts/…), run with
 *                  DYLD_LIBRARY_PATH = artifacts/{libimobiledevice,libimobiledeviceglue,libplist,libusbmuxd,openssl}
 *  xcrun simctl / devicectl: availability probed without triggering the CLT install dialog.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerSettings } from '@durbun/protocol';
import { run } from './exec';

export type ToolSource = 'settings' | 'env' | 'sdk' | 'path' | 'flutter-cache';

export interface ResolvedTool {
  path: string;
  /** Extra environment (DYLD_LIBRARY_PATH for Flutter's cached libimobiledevice). */
  env?: Record<string, string>;
  source: ToolSource;
  /** English note, e.g. "from Flutter 3.38.5 cache" or a problem with the configured path. */
  detail?: string;
}

export interface ResolveEnv {
  env: NodeJS.ProcessEnv;
  home: string;
}

export function defaultResolveEnv(): ResolveEnv {
  return { env: process.env, home: os.homedir() };
}

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

export function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const extra of ['/opt/homebrew/bin', '/usr/local/bin']) if (!dirs.includes(extra)) dirs.push(extra);
  return dirs;
}

export function findOnPath(name: string, renv: ResolveEnv): string | null {
  for (const dir of pathDirs(renv.env)) {
    const p = path.join(expandHome(dir, renv.home), name);
    if (isExecutableFile(p)) return p;
  }
  return null;
}

/* ───────────── adb ───────────── */

export function resolveAdb(settings: Pick<ServerSettings, 'adbPath'>, renv = defaultResolveEnv()): ResolvedTool | null {
  let note: string | undefined;
  if (settings.adbPath && settings.adbPath.trim()) {
    const p = expandHome(settings.adbPath.trim(), renv.home);
    if (isExecutableFile(p)) return { path: p, source: 'settings' };
    note = `Configured adbPath "${settings.adbPath}" is not an executable file`;
  }
  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT'] as const) {
    const root = renv.env[key];
    if (root) {
      const p = path.join(expandHome(root, renv.home), 'platform-tools', 'adb');
      if (isExecutableFile(p)) return { path: p, source: 'env', detail: note };
    }
  }
  const sdk = path.join(renv.home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb');
  if (isExecutableFile(sdk)) return { path: sdk, source: 'sdk', detail: note };
  const onPath = findOnPath('adb', renv);
  if (onPath) return { path: onPath, source: 'path', detail: note };
  return null;
}

/* ───────────── Flutter cache ───────────── */

const FLUTTER_LIB_DIRS = ['libimobiledevice', 'libimobiledeviceglue', 'libplist', 'libusbmuxd', 'openssl'];

/** Flutter SDK roots, most relevant first (PATH flutter, FLUTTER_ROOT, fvm, common folders). */
export function findFlutterRoots(renv = defaultResolveEnv()): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (root: string | undefined) => {
    if (!root) return;
    let real: string;
    try {
      real = fs.realpathSync(root);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    if (!fs.existsSync(path.join(real, 'bin', 'cache'))) return;
    seen.add(real);
    roots.push(real);
  };
  const flutterBin = findOnPath('flutter', renv);
  if (flutterBin) {
    try {
      add(path.dirname(path.dirname(fs.realpathSync(flutterBin))));
    } catch {
      /* broken symlink */
    }
  }
  if (renv.env.FLUTTER_ROOT) add(expandHome(renv.env.FLUTTER_ROOT, renv.home));
  add(path.join(renv.home, 'fvm', 'default'));
  const versionsDir = path.join(renv.home, 'fvm', 'versions');
  try {
    const versions = fs
      .readdirSync(versionsDir)
      .filter((v) => !v.startsWith('.'))
      .sort((a, b) => compareVersionsDesc(a, b));
    for (const v of versions) add(path.join(versionsDir, v));
  } catch {
    /* no fvm */
  }
  add(path.join(renv.home, 'flutter'));
  add(path.join(renv.home, 'development', 'flutter'));
  return roots;
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number(x));
  const pb = b.split(/[.+-]/).map((x) => Number(x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return b.localeCompare(a);
    if (x !== y) return y - x;
  }
  return 0;
}

/** DYLD_LIBRARY_PATH for binaries inside `<flutter>/bin/cache/artifacts`. */
export function flutterArtifactsEnv(artifactsDir: string): Record<string, string> {
  return { DYLD_LIBRARY_PATH: FLUTTER_LIB_DIRS.map((d) => path.join(artifactsDir, d)).join(':') };
}

/** If `toolPath` lives in a Flutter artifacts folder, the matching env; else undefined. */
export function envForArtifactsBinary(toolPath: string): Record<string, string> | undefined {
  const marker = `${path.sep}bin${path.sep}cache${path.sep}artifacts${path.sep}`;
  const idx = toolPath.indexOf(marker);
  if (idx === -1) return undefined;
  return flutterArtifactsEnv(toolPath.slice(0, idx + marker.length - 1));
}

export type IdeviceToolName = 'idevicesyslog' | 'idevicescreenshot' | 'iproxy';

function artifactSubdir(name: IdeviceToolName): string {
  return name === 'iproxy' ? 'libusbmuxd' : 'libimobiledevice';
}

export function resolveIdeviceTool(
  name: IdeviceToolName,
  settings: Pick<ServerSettings, 'idevicesyslogPath'>,
  renv = defaultResolveEnv(),
): ResolvedTool | null {
  let note: string | undefined;
  const configured = settings.idevicesyslogPath?.trim();
  if (configured) {
    const syslogPath = expandHome(configured, renv.home);
    const candidate = name === 'idevicesyslog' ? syslogPath : path.join(path.dirname(syslogPath), name);
    if (isExecutableFile(candidate)) {
      return { path: candidate, source: 'settings', env: envForArtifactsBinary(candidate) };
    }
    if (name === 'idevicesyslog') note = `Configured idevicesyslogPath "${configured}" is not an executable file`;
  }
  const onPath = findOnPath(name, renv);
  if (onPath) return { path: onPath, source: 'path', env: envForArtifactsBinary(onPath), detail: note };
  for (const root of findFlutterRoots(renv)) {
    const artifacts = path.join(root, 'bin', 'cache', 'artifacts');
    const p = path.join(artifacts, artifactSubdir(name), name);
    if (isExecutableFile(p)) {
      const version = readFlutterVersion(root);
      return {
        path: p,
        source: 'flutter-cache',
        env: flutterArtifactsEnv(artifacts),
        detail: `from Flutter${version ? ` ${version}` : ''} cache (${root})${note ? ` · ${note}` : ''}`,
      };
    }
  }
  return null;
}

function readFlutterVersion(root: string): string | undefined {
  try {
    const v = fs.readFileSync(path.join(root, 'version'), 'utf8').trim();
    if (/^\d+\.\d+/.test(v)) return v.split('\n')[0];
  } catch {
    /* ignore */
  }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'bin', 'cache', 'flutter.version.json'), 'utf8')) as {
      frameworkVersion?: string;
      flutterVersion?: string;
    };
    return j.flutterVersion ?? j.frameworkVersion;
  } catch {
    return undefined;
  }
}

/* ───────────── Xcode tools ───────────── */

export interface XcodeTools {
  available: boolean;
  /** xcrun path (always /usr/bin/xcrun on macOS). */
  xcrun: string;
  developerDir?: string;
  simctl: boolean;
  devicectl: boolean;
  detail?: string;
}

let xcodeCache: { at: number; value: XcodeTools } | undefined;

/**
 * Probe `xcode-select -p` first (never triggers the "install command line tools" dialog), then
 * `xcrun --find simctl|devicectl`. Cached for 60 s.
 */
export async function probeXcodeTools(force = false): Promise<XcodeTools> {
  if (!force && xcodeCache && Date.now() - xcodeCache.at < 60_000) return xcodeCache.value;
  const value = await probeXcodeToolsUncached();
  xcodeCache = { at: Date.now(), value };
  return value;
}

async function probeXcodeToolsUncached(): Promise<XcodeTools> {
  const xcrun = '/usr/bin/xcrun';
  const none = (detail: string): XcodeTools => ({ available: false, xcrun, simctl: false, devicectl: false, detail });
  if (process.platform !== 'darwin') return none('Xcode tools are only available on macOS');
  if (!isExecutableFile(xcrun)) return none('xcrun not found');
  const sel = await run('/usr/bin/xcode-select', ['-p'], { timeoutMs: 5000 });
  const developerDir = sel.ok ? sel.stdout.trim() : undefined;
  if (!developerDir) return none('No Xcode developer directory selected (xcode-select -p failed)');
  if (developerDir.includes('CommandLineTools')) {
    return { ...none('Only the Command Line Tools are selected; simctl/devicectl need Xcode'), developerDir };
  }
  const [simctl, devicectl] = await Promise.all([
    run(xcrun, ['--find', 'simctl'], { timeoutMs: 10_000 }),
    run(xcrun, ['--find', 'devicectl'], { timeoutMs: 10_000 }),
  ]);
  return {
    available: simctl.ok,
    xcrun,
    developerDir,
    simctl: simctl.ok,
    devicectl: devicectl.ok,
    detail: simctl.ok ? undefined : `xcrun cannot find simctl (${developerDir})`,
  };
}
