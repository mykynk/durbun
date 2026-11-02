/**
 * App / device identity for a VM-service session. The VM itself only knows its pid, OS and root library,
 * so the identity is assembled from the best source available: an SDK session of the same process, the
 * process name seen in device logs (Android: the package), the local .app bundle (iOS simulator / macOS)
 * and finally the root library's package name.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { AppInfo, AppSession, DeviceHints, DeviceInfo, SdkCapability } from '@durbun/protocol';

export interface BundleInfo {
  id?: string;
  name?: string;
  version?: string;
  build?: string;
  executable?: string;
}

/** `package:pati/main.dart` → `pati`; `file:///x/bin/server.dart` → `server`. */
export function packageNameFromLibraryUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const pkg = /^package:([A-Za-z_][A-Za-z0-9_]*)\//.exec(uri);
  if (pkg) return pkg[1];
  let pathname = uri;
  try {
    pathname = decodeURIComponent(new URL(uri).pathname);
  } catch {
    // not a URL: treat as a path
  }
  const base = pathname.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.dart$/, '');
  return base || undefined;
}

/** Android process names may carry a `:service` suffix. */
export function cleanProcessName(name: string | undefined): string | undefined {
  const n = name?.trim();
  if (!n) return undefined;
  const colon = n.indexOf(':');
  return colon > 0 ? n.slice(0, colon) : n;
}

/** Reverse-DNS application id such as `com.mykynk.pati`. */
export function looksLikeBundleId(name: string | undefined): boolean {
  return !!name && /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/.test(name);
}

export interface AppIdentityInput {
  packageName?: string;
  processName?: string;
  bundle?: BundleInfo;
  sdkApp?: AppInfo;
  pid?: number;
  debug?: boolean;
}

export function deriveAppInfo(input: AppIdentityInput): AppInfo {
  const proc = cleanProcessName(input.processName);
  const id =
    input.sdkApp?.id ??
    input.bundle?.id ??
    (looksLikeBundleId(proc) ? proc : undefined) ??
    input.packageName ??
    proc ??
    'dart-vm-app';
  const name = input.sdkApp?.name ?? input.bundle?.name ?? input.packageName ?? proc ?? 'Dart app';
  const info: AppInfo = { name, id };
  const version = input.sdkApp?.version ?? input.bundle?.version;
  const build = input.sdkApp?.build ?? input.bundle?.build;
  if (version) info.version = version;
  if (build) info.build = build;
  if (typeof input.pid === 'number' && input.pid > 0) info.pid = input.pid;
  const processName = input.processName?.trim() || input.bundle?.executable || input.sdkApp?.processName;
  if (processName) info.processName = processName;
  if (input.debug !== undefined) info.debug = input.debug;
  return info;
}

/** Run a command (no shell); resolves with stdout or undefined on any failure. */
export function execFileText(cmd: string, args: string[], timeoutMs = 3000): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        resolve(err ? undefined : String(stdout));
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** Executable path of a host process (macOS/Linux `ps`). Simulator apps are host processes. */
export async function hostExecutablePath(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return undefined;
  const out = await execFileText('ps', ['-o', 'comm=', '-p', String(pid)], 2000);
  const line = out?.split('\n')[0]?.trim();
  return line || undefined;
}

export function simulatorUdidFromPath(executable: string | undefined): string | undefined {
  const m = executable ? /\/CoreSimulator\/Devices\/([0-9A-Fa-f-]{36})\//.exec(executable) : null;
  return m ? m[1]!.toUpperCase() : undefined;
}

/** `/…/Runner.app/Runner` or `/…/Foo.app/Contents/MacOS/Foo` → the `.app` directory. */
export function appBundleDir(executable: string | undefined): string | undefined {
  if (!executable) return undefined;
  const idx = executable.lastIndexOf('.app/');
  return idx > 0 ? executable.slice(0, idx + 4) : undefined;
}

/** Info.plist of a local .app (iOS simulator layout or macOS `Contents/`), via `plutil` (macOS only). */
export async function readBundleInfo(appDir: string): Promise<BundleInfo | undefined> {
  if (process.platform !== 'darwin') return undefined;
  for (const plist of [path.join(appDir, 'Info.plist'), path.join(appDir, 'Contents', 'Info.plist')]) {
    const out = await execFileText('plutil', ['-convert', 'json', '-o', '-', plist], 3000);
    if (!out) continue;
    try {
      const p = JSON.parse(out) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      return {
        id: str(p.CFBundleIdentifier),
        name: str(p.CFBundleDisplayName) ?? str(p.CFBundleName),
        version: str(p.CFBundleShortVersionString),
        build: str(p.CFBundleVersion),
        executable: str(p.CFBundleExecutable),
      };
    } catch {
      // try the next layout
    }
  }
  return undefined;
}

export interface HostProcessInfo {
  simulatorUdid?: string;
  bundle?: BundleInfo;
}

/**
 * Identity of a VM whose pid is a host process: iOS simulator apps (path inside CoreSimulator) and
 * desktop processes. For `ios` VMs only simulator paths are trusted (a physical device's pid could
 * collide with an unrelated host process).
 */
export async function inspectHostProcess(pid: number, vmOs: string | undefined): Promise<HostProcessInfo> {
  const os = (vmOs ?? '').toLowerCase();
  if (os !== 'ios' && os !== 'macos') return {};
  const exe = await hostExecutablePath(pid);
  if (!exe) return {};
  const simulatorUdid = simulatorUdidFromPath(exe);
  if (os === 'ios' && !simulatorUdid) return {};
  const dir = appBundleDir(exe);
  const bundle = dir ? await readBundleInfo(dir) : undefined;
  return { simulatorUdid, bundle };
}

const OS_LABEL: Record<string, string> = { macos: 'macOS', linux: 'Linux', windows: 'Windows', fuchsia: 'Fuchsia' };

export function deviceHintsFor(vmOs: string | undefined, extra: { simulatorUdid?: string } = {}): DeviceHints {
  const os = (vmOs ?? '').toLowerCase();
  if (os === 'android') return { platform: 'android' };
  if (os === 'ios') {
    return extra.simulatorUdid ? { platform: 'ios', simulatorUdid: extra.simulatorUdid, isPhysical: false } : { platform: 'ios' };
  }
  const label = OS_LABEL[os] ?? (os || 'Desktop');
  return { platform: 'other', name: `${label} (Dart VM)`, model: 'Dart VM', isPhysical: true };
}

/** The only online device of a platform, if exactly one exists. */
export function uniqueOnlineDevice(devices: DeviceInfo[], platform: 'android' | 'ios'): string | undefined {
  const matches = devices.filter((d) => d.platform === platform && d.state === 'online');
  return matches.length === 1 ? matches[0]!.id : undefined;
}

/** A connected SDK session (not a VM-service one) of the same process. */
export function sdkSessionForPid(
  apps: AppSession[],
  deviceId: string | undefined,
  pid: number | undefined,
  capability?: SdkCapability,
): AppSession | undefined {
  if (!pid) return undefined;
  return apps.find(
    (a) =>
      a.connected &&
      a.transport !== 'vm-service' &&
      a.app.pid === pid &&
      (!deviceId || a.deviceId === deviceId) &&
      (!capability || a.capabilities.includes(capability)),
  );
}
