/**
 * "What can I see for this app, where does it come from, and why is something missing?" (SPEC §10).
 *
 * FROZEN CONTRACT between the UI engineers: keep every exported name, type and signature; add optional
 * fields, new reason codes, new sources and new actions freely. `explainSources` is a pure function —
 * the sidebar badges, the "Neler görünüyor?" panel and the Network / Performance / Mocks empty states all
 * render from it so they can never disagree.
 */
import type { AppSession, DeviceApp, DeviceInfo } from '@durbun/protocol';

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
  | 'readOnly';

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
  /** Why it is 'partial' / 'no' (empty when fully available). */
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

export interface ExplainResult {
  badge: ExplainBadge;
  rows: ExplainRow[];
}

/**
 * Pure: derive the matrix from what the device and the sessions report. Must not read stores.
 * Contract stub — the ui engineer replaces the body (same signature).
 */
export function explainSources(input: ExplainInput): ExplainResult {
  const session = input.sessions.find((s) => s.connected) ?? input.sessions[0];
  const badge: ExplainBadge = session ? (session.transport === 'vm-service' ? 'vm-service' : 'sdk') : 'device-only';
  return { badge, rows: [] };
}
