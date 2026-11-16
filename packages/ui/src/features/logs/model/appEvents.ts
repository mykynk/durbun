import type { LogEntry } from '@durbun/protocol';

/**
 * SDK lines with a known shape that the log list words and styles itself:
 * - how an earlier launch ended (`app-exit`: Android `ApplicationExitInfo`, API 30+; `app-diagnostics`: iOS MetricKit),
 * - screen changes (`navigation` events: React Native `trackNavigation`, the Flutter navigator observer),
 * - app lifecycle lines of the Flutter SDK (tag `lifecycle`, "AppLifecycleState.paused").
 */

type Data = Record<string, unknown>;
/** A line, or the part of it these readers need (`source` absent = not known to come from an SDK). */
type Src = Pick<LogEntry, 'data'> & Partial<Pick<LogEntry, 'source'>>;

const dataOf = (e: Pick<LogEntry, 'data'>): Data | undefined => (e.data && typeof e.data === 'object' && !Array.isArray(e.data) ? (e.data as Data) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Android `importance` names the SDK sends that mean the app was on screen (≤ IMPORTANCE_VISIBLE). */
const ON_SCREEN = new Set(['foreground', 'foregroundService', 'visible']);

export type ExitReport =
  | {
      platform: 'android';
      /** `data.exitReason`: anr, crashNative, lowMemory, excessiveResourceUsage, signaled, initializationFailure, permissionChange, dependencyDied, freezer… */
      reason: string;
      onScreen: boolean;
      signal?: number;
      description?: string;
    }
  | {
      platform: 'ios';
      /** `data.diagnostic`: crash, hang, cpuException, diskWriteException, slowLaunch. */
      reason: string;
      watchdog: boolean;
      exception?: string;
      signal?: number;
      terminationReason?: string;
      durationSeconds?: number;
      cpuSeconds?: number;
      sampledSeconds?: number;
      writtenMB?: number;
    };

/** The earlier-launch report a line carries, or undefined for any other line. */
export function exitReportOf(e: Src): ExitReport | undefined {
  if (e.source !== 'app') return undefined;
  const d = dataOf(e);
  if (!d || d.previousLaunch !== true) return undefined;
  const exitReason = text(d.exitReason);
  if (exitReason) {
    return {
      platform: 'android',
      reason: exitReason,
      onScreen: typeof d.importance === 'string' && ON_SCREEN.has(d.importance),
      ...(num(d.signal) !== undefined ? { signal: num(d.signal) } : {}),
      ...(text(d.description) ? { description: text(d.description) } : {}),
    };
  }
  const diagnostic = text(d.diagnostic);
  if (diagnostic && d.source === 'MetricKit') {
    const reason = text(d.terminationReason);
    return {
      platform: 'ios',
      reason: diagnostic,
      watchdog: !!reason && reason.toLowerCase().includes('8badf00d'),
      ...(num(d.signal) !== undefined ? { signal: num(d.signal) } : {}),
      ...(reason ? { terminationReason: reason } : {}),
      ...(num(d.durationSeconds) !== undefined ? { durationSeconds: num(d.durationSeconds) } : {}),
      ...(num(d.cpuSeconds) !== undefined ? { cpuSeconds: num(d.cpuSeconds) } : {}),
      ...(num(d.sampledSeconds) !== undefined ? { sampledSeconds: num(d.sampledSeconds) } : {}),
      ...(num(d.writtenMB) !== undefined ? { writtenMB: num(d.writtenMB) } : {}),
    };
  }
  return undefined;
}

/** An earlier launch the system closed to free memory (Android low-memory killer, reported at the next start). */
export function exitMemoryKill(e: Src): { visible: boolean } | undefined {
  const r = exitReportOf(e);
  return r?.platform === 'android' && r.reason === 'lowMemory' ? { visible: r.onScreen } : undefined;
}

/** An earlier launch that ended in an ANR (the SDK sends it as a crash line). */
export function isExitAnr(e: Src): boolean {
  const r = exitReportOf(e);
  return r?.platform === 'android' && r.reason === 'anr';
}

const SIGNALS: Record<number, string> = { 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE', 9: 'SIGKILL', 11: 'SIGSEGV', 15: 'SIGTERM', 31: 'SIGSYS' };

export function signalName(signal: number | undefined): string {
  if (signal === undefined) return '?';
  return SIGNALS[signal] ?? `signal ${signal}`;
}

/** Message key under `logs.exit.` and its params; undefined for a reason the UI does not know (the SDK's text is shown). */
export function exitReportMessage(r: ExitReport, fmt: { seconds(s: number): string }): { key: string; params?: Record<string, string | number> } | undefined {
  if (r.platform === 'android') {
    switch (r.reason) {
      case 'anr':
        return { key: 'android.anr' };
      case 'crashNative':
        return { key: 'android.crashNative', params: { signal: signalName(r.signal) } };
      case 'lowMemory':
        return { key: r.onScreen ? 'android.lowMemoryOnScreen' : 'android.lowMemoryBackground' };
      case 'excessiveResourceUsage':
        return { key: 'android.excessiveResourceUsage' };
      case 'signaled':
        return { key: 'android.signaled', params: { signal: signalName(r.signal) } };
      case 'initializationFailure':
        return { key: 'android.initializationFailure' };
      case 'permissionChange':
        return { key: 'android.permissionChange' };
      case 'dependencyDied':
        return { key: 'android.dependencyDied' };
      case 'freezer':
        return { key: 'android.freezer' };
      default:
        return undefined;
    }
  }
  const s = (v: number | undefined) => (v === undefined ? '?' : fmt.seconds(v));
  switch (r.reason) {
    case 'crash':
      if (r.watchdog) return { key: 'ios.watchdog' };
      return { key: 'ios.crash', params: { detail: [r.signal !== undefined ? signalName(r.signal) : '', r.terminationReason ?? ''].filter(Boolean).join(' · ') || '?' } };
    case 'hang':
      return { key: 'ios.hang', params: { time: s(r.durationSeconds) } };
    case 'cpuException':
      return { key: 'ios.cpuException', params: { cpu: s(r.cpuSeconds), window: s(r.sampledSeconds) } };
    case 'diskWriteException':
      return { key: 'ios.diskWriteException', params: { mb: r.writtenMB === undefined ? '?' : Math.round(r.writtenMB) } };
    case 'slowLaunch':
      return { key: 'ios.slowLaunch', params: { time: s(r.durationSeconds) } };
    default:
      return undefined;
  }
}

/** A screen change (`navigation` event): where the app went, and from where when known. */
export function navigationOf(e: Pick<LogEntry, 'kind' | 'message' | 'data'>): { to: string; from?: string } | undefined {
  if (e.kind !== 'event' || e.message !== 'navigation') return undefined;
  const d = dataOf(e);
  const to = text(d?.to);
  if (!to) return undefined;
  const from = text(d?.from);
  return from ? { to, from } : { to };
}

/** The event the native SDKs send once per process with the cold-start time (Android `LaunchTimer`, iOS `LaunchTiming`). */
export const LAUNCH_EVENT = 'durbun.launch';

export type LaunchInfo =
  /** `ms` from the process start (Android 13+: from the launch request, `from: 'launchRequest'`) to the first frame. */
  | { kind: 'cold'; ms: number; from?: string; screen?: string }
  /** iOS started the process ahead of the tap (prewarm): the process start says nothing about the wait, so no time. */
  | { kind: 'prewarmed'; screen?: string };

/** The cold-start report a line carries (`durbun.launch` event), or undefined (any other line, or a shape the UI does not know). */
export function launchOf(e: Pick<LogEntry, 'kind' | 'message' | 'data'>): LaunchInfo | undefined {
  if (e.kind !== 'event' || e.message !== LAUNCH_EVENT) return undefined;
  const d = dataOf(e);
  if (!d) return undefined;
  const screen = text(d.screen);
  const extra = screen ? { screen } : {};
  if (d.kind === 'prewarmed') return { kind: 'prewarmed', ...extra };
  const ms = num(d.ms);
  // A cold start with its duration; a kind a newer SDK may add stays a plain event line (never called "cold").
  if (ms === undefined || ms < 0 || (d.kind !== undefined && d.kind !== 'cold')) return undefined;
  const from = text(d.from);
  return { kind: 'cold', ms, ...(from ? { from } : {}), ...extra };
}

export type AppLifecycle = 'resumed' | 'inactive' | 'hidden' | 'paused' | 'detached';
const LIFECYCLE = /^AppLifecycleState\.(resumed|inactive|hidden|paused|detached)$/;

/** A Flutter SDK lifecycle line ("AppLifecycleState.paused", tag `lifecycle`). */
export function appLifecycleOf(e: Pick<LogEntry, 'source' | 'tag' | 'message'>): AppLifecycle | undefined {
  if (e.source !== 'app' || e.tag !== 'lifecycle') return undefined;
  return (LIFECYCLE.exec(e.message.trim())?.[1] as AppLifecycle | undefined) ?? undefined;
}
