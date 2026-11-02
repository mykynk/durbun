/**
 * Runtime detection and app/device description for `hello`. Works without react-native: every lookup is
 * optional and guarded, so the same package runs in React Native (Hermes/JSC), browsers and Node.
 */
import type { AppInfo, DeviceHints, DevicePlatform, SdkPlatform } from './protocol.js';
import { attempt, g, hostOfUrl, originOfUrl, queryParam, type AnyRecord } from './util.js';

declare const __DEV__: boolean | undefined;
// Module-scoped: bundlers rewrite `process.env.NODE_ENV`; Metro rewrites `require('react-native')`.
declare const process: { env: Record<string, string | undefined> } | undefined;
declare const require: (id: string) => unknown;

export type Runtime = 'react-native' | 'web' | 'node' | 'unknown';

export function detectRuntime(): Runtime {
  const nav = g.navigator;
  if (nav && nav.product === 'ReactNative') return 'react-native';
  const proc = g.process;
  const isNode = !!(proc && proc.versions && typeof proc.versions.node === 'string');
  if (typeof g.document === 'object' && g.document && typeof g.window === 'object') return 'web';
  if (isNode) return 'node';
  if (typeof g.importScripts === 'function') return 'web';
  return 'unknown';
}

/** Default for `enabled`: `__DEV__` in React Native; otherwise off only in production builds. */
export function defaultEnabled(): boolean {
  if (typeof __DEV__ !== 'undefined') return !!__DEV__;
  try {
    // Written literally so web bundlers can replace it with "production" at build time.
    if (process!.env.NODE_ENV === 'production') return false;
  } catch {
    // no process.env in this runtime
  }
  return true;
}

export function isDevBuild(): boolean | undefined {
  if (typeof __DEV__ !== 'undefined') return !!__DEV__;
  try {
    const env = process!.env.NODE_ENV;
    if (env) return env !== 'production';
  } catch {
    // ignore
  }
  return undefined;
}

/* ────────────────────────────── React Native lookups ────────────────────────────── */

let rnModule: AnyRecord | null | undefined;

/** `require('react-native')` when bundled by Metro; undefined on web/Node (the require throws there). */
export function loadReactNative(): AnyRecord | undefined {
  if (rnModule !== undefined) return rnModule || undefined;
  rnModule = null;
  if (detectRuntime() !== 'react-native') return undefined;
  try {
    const mod = require('react-native') as AnyRecord | undefined;
    if (mod && typeof mod === 'object') rnModule = mod;
  } catch {
    rnModule = null;
  }
  return rnModule || undefined;
}

/** Test hook: inject a fake `react-native` module (or `undefined` to re-detect). */
export function __setReactNativeModuleForTests(mod: AnyRecord | undefined): void {
  rnModule = mod === undefined ? undefined : mod;
}

function rnPlatform(rn: AnyRecord | undefined): AnyRecord | undefined {
  return attempt(() => (rn && rn.Platform) || undefined, undefined);
}

function rnConstants(platform: AnyRecord | undefined): AnyRecord {
  return attempt(() => (platform && platform.constants) || {}, {});
}

/** URL the JS bundle was loaded from (Metro dev server) — gives the dev machine's host and often the app id. */
export function rnScriptUrl(rn: AnyRecord | undefined = loadReactNative()): string | undefined {
  return attempt(() => {
    const nm = rn && rn.NativeModules;
    const sc = nm && nm.SourceCode;
    if (!sc) return undefined;
    if (typeof sc.scriptURL === 'string') return sc.scriptURL;
    if (typeof sc.getConstants === 'function') {
      const c = sc.getConstants();
      if (c && typeof c.scriptURL === 'string') return c.scriptURL;
    }
    return undefined;
  }, undefined);
}

function expoApplication(): AnyRecord | undefined {
  return attempt(() => {
    const mod = g.expo && g.expo.modules && g.expo.modules.ExpoApplication;
    return mod && typeof mod === 'object' ? (mod as AnyRecord) : undefined;
  }, undefined);
}

function rnAppKey(rn: AnyRecord | undefined): string | undefined {
  return attempt(() => {
    const registry = rn && rn.AppRegistry;
    if (!registry || typeof registry.getAppKeys !== 'function') return undefined;
    const keys = (registry.getAppKeys() as unknown[]).filter((k): k is string => typeof k === 'string' && k !== 'LogBox');
    return keys[0];
  }, undefined);
}

const ANDROID_EMULATOR_RE = /generic|emulator|sdk_gphone|google_sdk|goldfish|ranchu|vbox|genymotion|emu64|sdk_phone/i;

/* ────────────────────────────── Hosts ────────────────────────────── */

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\./.test(h) || h.endsWith('.localhost');
}

/** Private/LAN hosts only: never auto-connect to a public address. */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h || isLoopbackHost(h)) return false;
  if (h.endsWith('.local')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

/** Extra desktop host candidates discovered from the environment (dev-server host on a LAN, emulator alias). */
export function discoverHosts(runtime: Runtime = detectRuntime()): string[] {
  const hosts: string[] = [];
  if (runtime === 'react-native') {
    const rn = loadReactNative();
    const script = rnScriptUrl(rn);
    if (script) hosts.push(hostOfUrl(script));
    const serverHost = attempt(() => rnConstants(rnPlatform(rn)).ServerHost, undefined);
    if (typeof serverHost === 'string' && serverHost) hosts.push(hostOfUrl(`http://${serverHost}`));
  } else if (runtime === 'web') {
    const hostname = attempt(() => g.location && g.location.hostname, undefined);
    if (typeof hostname === 'string') hosts.push(hostname);
  }
  return hosts.filter((h, i) => !!h && isPrivateHost(h) && hosts.indexOf(h) === i);
}

/** Origin of the Metro dev server (its traffic — symbolication etc. — is never captured). */
export function devServerOrigin(runtime: Runtime = detectRuntime()): string | undefined {
  if (runtime !== 'react-native') return undefined;
  const script = rnScriptUrl();
  if (!script || !/^https?:/i.test(script)) return undefined;
  return originOfUrl(script) || undefined;
}

/* ────────────────────────────── Description ────────────────────────────── */

export interface EnvironmentOverrides {
  appId?: string;
  appName?: string;
  appVersion?: string;
  device?: Partial<DeviceHints>;
}

export interface EnvironmentInfo {
  runtime: Runtime;
  sdkPlatform: SdkPlatform;
  app: AppInfo;
  device: DeviceHints;
}

function lastSegment(id: string): string {
  const parts = id.split(/[./]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : id;
}

function describeBrowser(ua: string): { name: string; platform: DevicePlatform; os?: string } {
  const platform: DevicePlatform = /Android/i.test(ua) ? 'android' : /iPhone|iPad|iPod/i.test(ua) ? 'ios' : 'other';
  const browser =
    (/Edg\/(\d+)/.exec(ua) && `Edge ${/Edg\/(\d+)/.exec(ua)![1]}`) ||
    (/Firefox\/(\d+)/.exec(ua) && `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}`) ||
    (/Chrome\/(\d+)/.exec(ua) && `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}`) ||
    (/Version\/([\d.]+).*Safari/.exec(ua) && `Safari ${/Version\/([\d.]+)/.exec(ua)![1]}`) ||
    'Browser';
  const os = /Android ([\d.]+)/.exec(ua)
    ? `Android ${/Android ([\d.]+)/.exec(ua)![1]}`
    : /OS (\d+[_\d]*) like Mac OS X/.exec(ua)
      ? `iOS ${/OS (\d+[_\d]*) like Mac OS X/.exec(ua)![1].replace(/_/g, '.')}`
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : undefined;
  return { name: os ? `${browser} · ${os}` : browser, platform, os };
}

function nodeScriptName(proc: AnyRecord): string | undefined {
  const script = attempt(() => (Array.isArray(proc.argv) ? proc.argv[1] : undefined), undefined);
  if (typeof script !== 'string' || !script) return undefined;
  const base = script.split(/[\\/]/).pop() || script;
  return base.replace(/\.(c|m)?(j|t)s$/, '') || undefined;
}

function compact<T extends object>(obj: T): T {
  for (const key of Object.keys(obj) as (keyof T)[]) if (obj[key] === undefined) delete obj[key];
  return obj;
}

/** Everything `hello` needs about the app and the device, with explicit overrides applied last. */
export function describeEnvironment(overrides: EnvironmentOverrides = {}, runtime: Runtime = detectRuntime()): EnvironmentInfo {
  const debug = isDevBuild();
  let app: AppInfo = { id: '', name: '' };
  let device: DeviceHints = { platform: 'other' };
  let sdkPlatform: SdkPlatform = 'js';
  let nameFromId = false;

  if (runtime === 'react-native') {
    sdkPlatform = 'react-native';
    const rn = loadReactNative();
    const platform = rnPlatform(rn);
    const consts = rnConstants(platform);
    const os = attempt(() => (platform ? String(platform.OS) : ''), '');
    const script = rnScriptUrl(rn);
    const expo = expoApplication();
    const bundleApp = script ? queryParam(script, 'app') : undefined;
    const appKey = rnAppKey(rn);
    const nativeId = (expo && typeof expo.applicationId === 'string' && expo.applicationId) || bundleApp || undefined;
    const id = nativeId || appKey || 'react-native-app';
    const nativeName = (expo && typeof expo.applicationName === 'string' && expo.applicationName) || appKey;
    nameFromId = !nativeName;
    app = {
      id,
      name: nativeName || lastSegment(id),
      version: expo && typeof expo.nativeApplicationVersion === 'string' ? expo.nativeApplicationVersion : undefined,
      build: expo && typeof expo.nativeBuildVersion === 'string' ? expo.nativeBuildVersion : undefined,
      // Android process name == package name (lets the desktop link logcat lines to this app).
      processName: os === 'android' && nativeId ? nativeId : undefined,
      debug,
    };
    if (os === 'android') {
      const fingerprint = String(consts.Fingerprint || '');
      const model = typeof consts.Model === 'string' ? consts.Model : undefined;
      const version = attempt(() => platform!.Version, undefined);
      device = {
        platform: 'android',
        model,
        manufacturer: typeof consts.Manufacturer === 'string' ? consts.Manufacturer : undefined,
        osVersion: typeof consts.Release === 'string' ? consts.Release : undefined,
        apiLevel: typeof version === 'number' ? version : undefined,
        isPhysical: !(ANDROID_EMULATOR_RE.test(fingerprint) || ANDROID_EMULATOR_RE.test(model || '')),
      };
    } else if (os === 'ios') {
      const version = attempt(() => platform!.Version, undefined);
      const scriptHost = script && /^https?:/i.test(script) ? hostOfUrl(script) : '';
      device = {
        platform: 'ios',
        osVersion: typeof consts.osVersion === 'string' ? consts.osVersion : version !== undefined ? String(version) : undefined,
        // Dev builds load the bundle from localhost on a simulator and from the Mac's LAN address on a device.
        isPhysical: scriptHost ? !isLoopbackHost(scriptHost) : undefined,
      };
    } else {
      device = { platform: 'other', name: os || undefined };
    }
  } else if (runtime === 'web') {
    const ua = attempt(() => String(g.navigator && g.navigator.userAgent ? g.navigator.userAgent : ''), '');
    const info = describeBrowser(ua);
    const host = attempt(() => (g.location && typeof g.location.host === 'string' ? g.location.host : ''), '');
    const title = attempt(() => (g.document && typeof g.document.title === 'string' ? g.document.title.trim() : ''), '');
    app = { id: host || 'web-app', name: title || host || 'Web app', debug };
    device = { platform: info.platform, name: info.name, osVersion: info.os };
  } else if (runtime === 'node') {
    const proc = g.process as AnyRecord;
    const env = attempt(() => (proc.env || {}) as Record<string, string | undefined>, {} as Record<string, string | undefined>);
    const name = env.npm_package_name || nodeScriptName(proc) || 'node-app';
    app = {
      id: name,
      name,
      version: env.npm_package_version,
      pid: typeof proc.pid === 'number' ? proc.pid : undefined,
      processName: typeof proc.title === 'string' ? proc.title : undefined,
      debug,
    };
    device = {
      platform: 'other',
      name: `Node.js ${attempt(() => String(proc.version), '')}`.trim(),
      model: attempt(() => `${proc.platform} ${proc.arch}`, undefined),
      simulatorUdid: env.SIMULATOR_UDID || undefined,
    };
  } else {
    app = { id: 'js-app', name: 'JavaScript app', debug };
  }

  if (overrides.appId) {
    app.id = overrides.appId;
    if (nameFromId) app.name = lastSegment(overrides.appId);
  }
  if (overrides.appName) app.name = overrides.appName;
  if (overrides.appVersion) app.version = overrides.appVersion;
  if (runtime === 'react-native' && overrides.appId && device.platform === 'android') app.processName = overrides.appId;
  if (overrides.device) device = { ...device, ...compact({ ...overrides.device }) };
  return { runtime, sdkPlatform, app: compact(app), device: compact(device) };
}
