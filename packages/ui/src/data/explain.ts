/**
 * "What can I see for this app, where does it come from, and why is something missing?" (SPEC §10).
 *
 * FROZEN CONTRACT between the UI engineers: keep every exported name, type and signature; add optional
 * fields, new reason codes, new sources and new actions freely. `explainSources` is a pure function —
 * the sidebar badges, the "Neler görünüyor?" panel and the Network / Performance / Mocks empty states all
 * render from it so they can never disagree.
 */
import type { AppInstallSource, AppSession, DeviceApp, DeviceInfo, SdkPlatform } from '@durbun/protocol';

/** One row of the matrix. */
export type ExplainCapability = 'logs' | 'network' | 'metrics' | 'crashes' | 'mocks' | 'tools';

export type ExplainStatus = 'yes' | 'partial' | 'no';

/** Where data for a capability comes from (localized label + one-line description per id). */
export type ExplainSource =
  | 'logcat'
  | 'idevicesyslog'
  | 'simctl-log'
  | 'sdk'
  | 'vm-service'
  | 'dropbox'
  | 'crash-report'
  | 'proc-stats'
  | 'host-ps'
  | 'frame-stats'
  | 'demo'
  | 'import';

/**
 * Why a capability is missing or partial. Each code has a natural Turkish + English sentence that names
 * the concrete app / build when params allow (e.g. "Pati 2.3.0 (Play Store sürümü) içinde Dürbün SDK'sı yok").
 * A 'yes' row may carry reasons too: they are caveats worth knowing ("release builds may print little").
 */
export type ExplainReason =
  /** No SDK session and no VM-service session for this app. */
  | 'noSdk'
  /** Release build without the SDK (store / Firebase / ad-hoc): SDK-less methods only. */
  | 'releaseWithoutSdk'
  /** Installed from a store (Play, App Store / TestFlight): the SDK is never enabled there. */
  | 'storeBuild'
  /** Network capture from outside the app is impossible: SSL pinning + Android user-CA policy (no proxy route). */
  | 'noOutsideNetwork'
  /** VM-service sessions cannot apply mocks (rules run inside the SDK). */
  | 'vmServiceNoMocks'
  /** SDK connected but this capability is not in its capabilities (old SDK, disabled feature). */
  | 'sdkLacksCapability'
  /** Physical iOS devices expose no CPU / memory / FPS without Instruments. */
  | 'iosNoDeviceMetrics'
  /** Android FPS from outside the app is native-UI / surface based (see notes). */
  | 'frameStatsApproximate'
  /** Device logs are not streaming (tool missing, untrusted device…; see DeviceInfo.logs.code). */
  | 'deviceLogsUnavailable'
  /** A required desktop tool is missing (Doctor explains how to install it). */
  | 'toolMissing'
  /** Flutter release builds may print nothing to the device log (depends on the app's logger). */
  | 'releaseLogsDependOnApp'
  /** Native (Kotlin) network needs `.addInterceptor(DurbunInterceptor())` on the app's own OkHttp clients. */
  | 'nativeNetworkNeedsInterceptor'
  /** Requests made by third-party SDKs' own HTTP clients are not visible. */
  | 'thirdPartyTraffic'
  /** Crash stacks from the device are unsymbolicated (need the build's dSYM / mapping / split-debug-info). */
  | 'crashesUnsymbolicated'
  /** The app is not running and has not been seen yet in this session. */
  | 'notRunning'
  /** Imported / disconnected: read-only snapshot. */
  | 'readOnly'
  /** iOS simulator: CPU / memory come from the Mac's process list; FPS needs the app (SDK / Flutter debug). */
  | 'fpsNeedsApp'
  /** Connected over the network without USB (`net:` device): only what the SDK sends, no device log. */
  | 'networkOnly'
  /** In-app tools need the SDK / VM service, but device tools (launch, stop, clear data, screenshot) still work. */
  | 'deviceToolsAvailable'
  /** The SDK is running inside a build installed from a store — store builds should ship with it off. */
  | 'sdkInStoreBuild';

/** A button the UI can offer next to a reason. */
export type ExplainAction =
  | 'openSdkGuide'
  | 'openDoctor'
  | 'attachVm'
  | 'useDebugBuild'
  | 'buildWithDurbunFlag'
  | 'addInterceptor'
  | 'startProcessMetrics';

export interface ExplainRow {
  capability: ExplainCapability;
  status: ExplainStatus;
  /** Active sources, most important first (empty when status is 'no'). */
  sources: ExplainSource[];
  /** Why it is 'partial' / 'no' (empty when fully available; caveats on 'yes' rows). */
  reasons: ExplainReason[];
  actions: ExplainAction[];
}

export interface ExplainInput {
  device?: DeviceInfo;
  /** The app as the device reports it (build type, install source), when known. */
  deviceApp?: DeviceApp;
  /** SDK / VM-service sessions of the same app on the same device (connected first). */
  sessions: AppSession[];
}

/** Summary used by compact badges: which single source best describes the app. */
export type ExplainBadge = 'sdk' | 'vm-service' | 'device-only' | 'demo' | 'import';

/** Where the device is, as far as data sources go. */
export type ExplainPlatform = 'android' | 'ios-device' | 'ios-simulator' | 'other';

/** What carries the app's own data right now (or did last time it ran). */
export type ExplainTransport = 'sdk' | 'vm-service' | 'none' | 'demo' | 'import';

/** The build as far as data sources go ('xcode' = an iOS developer build). */
export type ExplainBuild = 'debug' | 'release' | 'store' | 'firebase' | 'xcode' | 'store-or-testflight' | 'unknown';

/** Derived facts the texts are written from (names the app, the build and where it was installed from). */
export interface ExplainContext {
  platform: ExplainPlatform;
  transport: ExplainTransport;
  build: ExplainBuild;
  install?: AppInstallSource;
  /** Raw installer package (Android 'other-store'). */
  installer?: string;
  sdkPlatform?: SdkPlatform;
  appName?: string;
  bundleId?: string;
  version?: string;
  buildNumber?: string;
  /** An SDK / VM session is connected or the device reports the app running. */
  running: boolean;
  /** Device log stream for this device: streaming, not streaming (see `logsCode`), or none at all (`net:`, import). */
  deviceLogs: 'ok' | 'unavailable' | 'none';
  logsCode?: string;
  deviceOnline: boolean;
  /** Device state ('disconnected' devices are read-only: their missing stream is not a problem to fix). */
  deviceState?: DeviceInfo['state'];
}

export interface ExplainResult {
  badge: ExplainBadge;
  rows: ExplainRow[];
  /** App-level notes shown above the matrix (not running, read-only, SDK in a store build). */
  notes?: ExplainReason[];
  context?: ExplainContext;
}

/** Compact build badge for the sidebar (Debug · Firebase · Play · Xcode · Store/TestFlight · Simülatör · Diğer mağaza). */
export type BuildBadge = 'debug' | 'release' | 'firebase' | 'play' | 'other-store' | 'xcode' | 'store-or-testflight' | 'simulator';

export const EXPLAIN_CAPABILITIES: readonly ExplainCapability[] = ['logs', 'network', 'metrics', 'crashes', 'mocks', 'tools'];

/* ───────────── derivation ───────────── */

const TOOL_MISSING_CODES = new Set(['logs.adbMissing', 'logs.idevicesyslogMissing', 'logs.simctlMissing', 'logs.usbmuxdUnavailable']);

function platformOf(device: DeviceInfo | undefined): ExplainPlatform {
  if (!device) return 'other';
  if (device.platform === 'android') return 'android';
  if (device.platform === 'ios') return device.kind === 'simulator' || device.id.startsWith('ios-sim:') ? 'ios-simulator' : 'ios-device';
  return 'other';
}

function isDemo(input: ExplainInput): boolean {
  return Boolean(input.device?.id.startsWith('demo:')) || input.sessions.some((s) => s.transport === 'demo' || s.sdk.platform === 'demo');
}

function isImport(input: ExplainInput): boolean {
  return Boolean(input.device?.id.startsWith('import:')) || input.sessions.some((s) => s.transport === 'import');
}

/** The session that describes the app best: connected first, SDK before VM service, newest first. */
function pickSession(sessions: readonly AppSession[]): AppSession | undefined {
  let best: AppSession | undefined;
  const rank = (s: AppSession) => (s.connected ? 2 : 0) + (s.transport === 'vm-service' ? 0 : 1);
  for (const s of sessions) {
    if (!best || rank(s) > rank(best) || (rank(s) === rank(best) && s.connectedAt > best.connectedAt)) best = s;
  }
  return best;
}

export function buildKindOf(deviceApp: DeviceApp | undefined, session: AppSession | undefined): ExplainBuild {
  if (deviceApp) {
    const bt = deviceApp.buildType;
    switch (deviceApp.install.source) {
      case 'play':
      case 'other-store':
        return 'store';
      case 'firebase':
        return 'firebase';
      case 'store-or-testflight':
        return 'store-or-testflight';
      case 'xcode':
        return bt === 'release' ? 'release' : 'xcode';
      case 'simulator':
        return bt === 'release' ? 'release' : 'debug';
      default:
        if (bt === 'debug') return 'debug';
        if (bt === 'release') return 'release';
    }
  }
  if (session?.app.debug === true) return 'debug';
  if (session?.app.debug === false) return 'release';
  return 'unknown';
}

/** Sidebar build badge, or undefined when nothing is known (demo / import / an SDK that does not say). */
export function buildBadgeOf(input: Pick<ExplainInput, 'deviceApp' | 'sessions' | 'device'>): BuildBadge | undefined {
  if (input.device && (input.device.id.startsWith('demo:') || input.device.id.startsWith('import:'))) return undefined;
  const da = input.deviceApp;
  if (da) {
    switch (da.install.source) {
      case 'play':
      case 'firebase':
      case 'other-store':
      case 'xcode':
      case 'store-or-testflight':
      case 'simulator':
        return da.install.source;
      default:
        if (da.buildType === 'debug') return 'debug';
        if (da.buildType === 'release') return 'release';
    }
  }
  const s = pickSession(input.sessions);
  if (s?.app.debug === true) return 'debug';
  if (s?.app.debug === false) return 'release';
  return undefined;
}

function isStoreLike(b: ExplainBuild): boolean {
  return b === 'store' || b === 'store-or-testflight';
}

function isDebugLike(b: ExplainBuild): boolean {
  return b === 'debug' || b === 'xcode';
}

function isReleaseLike(b: ExplainBuild): boolean {
  return b === 'release' || b === 'firebase' || isStoreLike(b);
}

/** Why the app's own data is missing without an SDK, by build. */
function noSdkReason(b: ExplainBuild): ExplainReason {
  if (isStoreLike(b)) return 'storeBuild';
  if (isReleaseLike(b)) return 'releaseWithoutSdk';
  return 'noSdk';
}

/** What would enable the app's own data, by build (debug: SDK or VM service; release: the SDK flag). */
function noSdkActions(b: ExplainBuild, platform: ExplainPlatform): ExplainAction[] {
  if (isStoreLike(b)) return ['useDebugBuild', 'buildWithDurbunFlag'];
  if (isReleaseLike(b)) return ['buildWithDurbunFlag', 'useDebugBuild'];
  if (isDebugLike(b) && platform !== 'other') return ['openSdkGuide', 'attachVm'];
  return ['openSdkGuide'];
}

export function explainContext(input: ExplainInput): ExplainContext {
  const device = input.device;
  const da = input.deviceApp;
  const session = pickSession(input.sessions);
  const platform = platformOf(device);
  const connected = input.sessions.some((s) => s.connected);
  let transport: ExplainTransport;
  if (isImport(input)) transport = 'import';
  else if (isDemo(input)) transport = 'demo';
  else if (!session) transport = 'none';
  else if (!session.connected && da?.running) transport = 'none'; // this run has no SDK (the old session ended)
  else transport = session.transport === 'vm-service' ? 'vm-service' : 'sdk';
  let deviceLogs: ExplainContext['deviceLogs'] = 'none';
  if (device && !device.id.startsWith('import:') && !device.id.startsWith('net:') && device.logs.code !== 'logs.networkOnly' && device.id !== 'desktop') {
    deviceLogs = device.state === 'online' && (device.logs.status === 'streaming' || device.logs.status === 'starting') ? 'ok' : 'unavailable';
  }
  return {
    platform,
    transport,
    build: buildKindOf(da, session),
    install: da?.install.source,
    installer: da?.install.installer,
    sdkPlatform: session?.sdk.platform,
    appName: session?.app.name || da?.name || undefined,
    bundleId: da?.id ?? session?.app.id,
    version: da?.version ?? session?.app.version,
    buildNumber: da?.build ?? session?.app.build,
    running: connected || Boolean(da?.running),
    deviceLogs,
    logsCode: device?.logs.code,
    deviceOnline: device?.state === 'online',
    deviceState: device?.state,
  };
}

function uniq<T>(list: T[]): T[] {
  return [...new Set(list)];
}

function row(capability: ExplainCapability, status: ExplainStatus, sources: ExplainSource[], reasons: ExplainReason[] = [], actions: ExplainAction[] = []): ExplainRow {
  return { capability, status, sources: status === 'no' ? [] : uniq(sources), reasons: uniq(reasons), actions: uniq(actions) };
}

function deviceLogSource(platform: ExplainPlatform): ExplainSource | undefined {
  if (platform === 'android') return 'logcat';
  if (platform === 'ios-device') return 'idevicesyslog';
  if (platform === 'ios-simulator') return 'simctl-log';
  return undefined;
}

function deviceCrashSource(platform: ExplainPlatform): ExplainSource | undefined {
  if (platform === 'android') return 'dropbox';
  if (platform === 'ios-device' || platform === 'ios-simulator') return 'crash-report';
  return undefined;
}

/** Device-log reasons + actions when the stream is down. */
function deviceLogProblems(ctx: ExplainContext): { reasons: ExplainReason[]; actions: ExplainAction[] } {
  if (ctx.deviceLogs !== 'unavailable' || ctx.deviceState === 'disconnected') return { reasons: [], actions: [] };
  const reasons: ExplainReason[] = ['deviceLogsUnavailable'];
  if (ctx.logsCode && TOOL_MISSING_CODES.has(ctx.logsCode)) reasons.push('toolMissing');
  return { reasons, actions: ['openDoctor'] };
}

function explainRecorded(input: ExplainInput): ExplainRow[] {
  // An imported recording: whatever the file holds, nothing live.
  const caps = new Set(input.sessions.flatMap((s) => s.capabilities));
  const had = (c: string) => caps.has(c as never);
  return [
    row('logs', 'yes', ['import']),
    had('network') ? row('network', 'yes', ['import']) : row('network', 'no', [], [input.sessions.length ? 'sdkLacksCapability' : 'noSdk']),
    had('metrics') ? row('metrics', 'yes', ['import']) : row('metrics', 'no', [], [input.sessions.length ? 'sdkLacksCapability' : 'noSdk']),
    row('crashes', 'yes', ['import']),
    row('mocks', 'no', [], ['readOnly']),
    row('tools', 'no', [], ['readOnly']),
  ];
}

/**
 * Pure: derive the matrix from what the device and the sessions report. Must not read stores.
 */
export function explainSources(input: ExplainInput): ExplainResult {
  const ctx = explainContext(input);
  const notes: ExplainReason[] = [];
  const session = ctx.transport === 'none' ? undefined : pickSession(input.sessions);
  const caps = new Set(session?.capabilities ?? []);
  const has = (c: string) => caps.has(c as never);

  /* badge */
  let badge: ExplainBadge;
  if (ctx.transport === 'import') badge = 'import';
  else if (ctx.transport === 'demo') badge = 'demo';
  else if (ctx.transport === 'sdk') badge = 'sdk';
  else if (ctx.transport === 'vm-service') badge = 'vm-service';
  else badge = 'device-only';

  if (ctx.transport === 'import') {
    return { badge, rows: explainRecorded(input), notes: ['readOnly'], context: ctx };
  }

  /* app-level notes */
  if (input.device && !ctx.deviceOnline) notes.push('readOnly');
  else if (!ctx.running && (input.deviceApp || input.sessions.length > 0)) notes.push('notRunning');
  if (ctx.transport === 'sdk' && isStoreLike(ctx.build)) notes.push('sdkInStoreBuild');

  const p = ctx.platform;
  const logSrc = ctx.deviceLogs === 'ok' ? deviceLogSource(p) : undefined;
  const crashSrc = ctx.deviceOnline || !input.device ? deviceCrashSource(p) : undefined;
  const logProblems = deviceLogProblems(ctx);
  const rows: ExplainRow[] = [];

  if (ctx.transport === 'demo') {
    // Demo data stands in for every source; it follows the simulated sessions' capabilities.
    const demoCaps = new Set(input.sessions.flatMap((s) => s.capabilities));
    const any = input.sessions.length === 0;
    const d = (c: ExplainCapability, cap?: string) =>
      any || !cap || demoCaps.has(cap as never) ? row(c, 'yes', ['demo']) : row(c, 'no', [], ['sdkLacksCapability']);
    return {
      badge,
      rows: [d('logs'), d('network', 'network'), d('metrics', 'metrics'), d('crashes'), d('mocks', 'mocks'), d('tools')],
      notes: notes.filter((n) => n !== 'sdkInStoreBuild'),
      context: ctx,
    };
  }

  const appSrc: ExplainSource | undefined = ctx.transport === 'sdk' ? 'sdk' : ctx.transport === 'vm-service' ? 'vm-service' : undefined;
  const buildReason = noSdkReason(ctx.build);
  const buildActions = noSdkActions(ctx.build, p);
  const androidNative = p === 'android' && (ctx.sdkPlatform === 'flutter' || ctx.sdkPlatform === 'android' || ctx.transport === 'vm-service');

  /* logs */
  if (appSrc) {
    const reasons: ExplainReason[] = [...logProblems.reasons];
    if (ctx.deviceLogs === 'none' && input.device && (input.device.id.startsWith('net:') || ctx.logsCode === 'logs.networkOnly')) reasons.push('networkOnly');
    const partial = logProblems.reasons.length > 0;
    rows.push(row('logs', partial ? 'partial' : 'yes', [appSrc, ...(logSrc ? [logSrc] : [])], reasons, logProblems.actions));
  } else if (logSrc) {
    rows.push(row('logs', 'yes', [logSrc], isReleaseLike(ctx.build) ? ['releaseLogsDependOnApp'] : []));
  } else {
    const reasons: ExplainReason[] = logProblems.reasons.length ? logProblems.reasons : [buildReason];
    rows.push(row('logs', 'no', [], reasons, logProblems.actions.length ? logProblems.actions : buildActions));
  }

  /* network */
  if (ctx.transport === 'sdk') {
    if (has('network')) {
      const reasons: ExplainReason[] = ['thirdPartyTraffic'];
      const actions: ExplainAction[] = [];
      if (androidNative) {
        reasons.unshift('nativeNetworkNeedsInterceptor');
        actions.push('addInterceptor');
      }
      rows.push(row('network', 'yes', ['sdk'], reasons, actions));
    } else rows.push(row('network', 'no', [], ['sdkLacksCapability'], ['openSdkGuide']));
  } else if (ctx.transport === 'vm-service') {
    rows.push(row('network', 'yes', ['vm-service'], ['nativeNetworkNeedsInterceptor'], ['openSdkGuide']));
  } else {
    rows.push(row('network', 'no', [], [buildReason, 'noOutsideNetwork'], buildActions));
  }

  /* metrics */
  const outside = (): ExplainRow | undefined => {
    if (p === 'android') return row('metrics', 'partial', ['proc-stats', 'frame-stats'], ['frameStatsApproximate'], ctx.deviceOnline ? ['startProcessMetrics'] : []);
    if (p === 'ios-simulator') return row('metrics', 'partial', ['host-ps'], ['fpsNeedsApp'], ctx.deviceOnline ? ['startProcessMetrics'] : []);
    return undefined;
  };
  if (appSrc && (ctx.transport === 'vm-service' || has('metrics'))) {
    rows.push(row('metrics', 'yes', [appSrc]));
  } else if (ctx.transport === 'sdk') {
    const o = outside();
    if (o) rows.push({ ...o, reasons: uniq(['sdkLacksCapability', ...o.reasons]) });
    else rows.push(row('metrics', 'no', [], p === 'ios-device' ? ['sdkLacksCapability', 'iosNoDeviceMetrics'] : ['sdkLacksCapability'], ['openSdkGuide']));
  } else {
    const o = outside();
    if (o) rows.push(o);
    else if (p === 'ios-device') rows.push(row('metrics', 'no', [], ['iosNoDeviceMetrics'], isDebugLike(ctx.build) ? ['openSdkGuide', 'attachVm'] : isStoreLike(ctx.build) ? ['useDebugBuild'] : ['buildWithDurbunFlag']));
    else rows.push(row('metrics', 'no', [], [buildReason], buildActions));
  }

  /* crashes */
  const deviceCrash: ExplainSource[] = [...(crashSrc ? [crashSrc] : []), ...(logSrc ? [logSrc] : [])];
  const unsym: ExplainReason[] = crashSrc === 'crash-report' ? ['crashesUnsymbolicated'] : [];
  if (appSrc) {
    rows.push(row('crashes', 'yes', [appSrc, ...deviceCrash]));
  } else if (deviceCrash.length > 0) {
    rows.push(row('crashes', 'yes', deviceCrash, unsym));
  } else {
    rows.push(row('crashes', 'no', [], logProblems.reasons.length ? logProblems.reasons : [buildReason], logProblems.actions.length ? logProblems.actions : buildActions));
  }

  /* mocks */
  const offline = Boolean(input.device) && !ctx.deviceOnline;
  if (ctx.transport === 'sdk') {
    if (offline) rows.push(row('mocks', 'no', [], ['readOnly']));
    else if (has('mocks')) rows.push(row('mocks', 'yes', ['sdk']));
    else rows.push(row('mocks', 'no', [], ['sdkLacksCapability'], ['openSdkGuide']));
  } else if (ctx.transport === 'vm-service') {
    rows.push(row('mocks', 'no', [], ['vmServiceNoMocks'], ['openSdkGuide']));
  } else {
    rows.push(row('mocks', 'no', [], [buildReason], buildActions));
  }

  /* tools (in-app debug tools; device tools work for every app) */
  if (offline) {
    rows.push(row('tools', 'no', [], ['readOnly']));
  } else if (ctx.transport === 'sdk') {
    if (has('commands') || (session?.actions.length ?? 0) > 0) rows.push(row('tools', 'yes', ['sdk']));
    else rows.push(row('tools', 'no', [], ['sdkLacksCapability', 'deviceToolsAvailable'], ['openSdkGuide']));
  } else if (ctx.transport === 'vm-service') {
    rows.push(row('tools', 'yes', ['vm-service']));
  } else {
    rows.push(row('tools', 'no', [], input.device ? [buildReason, 'deviceToolsAvailable'] : [buildReason], buildActions));
  }

  return { badge, rows, notes, context: ctx };
}

/** Row for one capability (always present in a result). */
export function explainRow(result: ExplainResult, capability: ExplainCapability): ExplainRow | undefined {
  return result.rows.find((r) => r.capability === capability);
}
