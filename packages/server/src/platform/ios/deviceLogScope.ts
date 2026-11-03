/**
 * `ServerSettings.iosDeviceLogScope` for physical iPhones (SPEC §10.8). A busy phone sends ~1,000–1,400
 * idevicesyslog lines per second, almost all from Apple daemons, and would fill the hub's shared log ring in
 * minutes. 'apps' (the default, also when the setting is absent) keeps:
 *   - lines of third-party app processes: the pid belongs to a DeviceApp of the device (devicectl process
 *     list, app extensions included) or the process name is a third-party executable;
 *   - lines of a process no listing has explained yet whose name looks like a third-party executable (an app
 *     installed, or an app extension started, after the last listing): kept until the process listing this
 *     asks for decides (`ThirdPartyApps.keepsUnknownProcess`);
 *   - crash-relevant system lines that name a third-party bundle id (app extensions too), pid or app process:
 *     everything ReportCrash / osanalyticshelper / spindump say about it (crash and hang reports), and the
 *     termination reasons, exits, kills and watchdog / jetsam / EXC_RESOURCE events that SpringBoard,
 *     runningboardd, kernel, launchd, backboardd … report (their assertion and state chatter is dropped);
 *   - "*** Terminating app due to uncaught exception" rows of any process.
 * 'all' keeps everything. While the device's third-party apps are unknown (first listing pending, or no
 * devicectl) nothing is dropped: the filter never hides a line it cannot attribute. The scope is read per
 * line, so a settings change applies at once without restarting the stream.
 */
import type { ServerSettings } from '@durbun/protocol';
import type { DeviceLogInput } from '../../types';

export type IosDeviceLogScope = NonNullable<ServerSettings['iosDeviceLogScope']>;

/** `iosDeviceLogScope` with the protocol default ('apps' when absent or unknown). */
export function iosDeviceLogScope(settings: Partial<Pick<ServerSettings, 'iosDeviceLogScope'>> | undefined): IosDeviceLogScope {
  return settings?.iosDeviceLogScope === 'all' ? 'all' : 'apps';
}

/** What the device knows about its third-party apps (IosAppTracker). */
export interface ThirdPartyApps {
  /** An installed-app listing succeeded at least once. */
  readonly knowsApps: boolean;
  /** pid of a running third-party app process (app or app extension). */
  isAppPid(pid: number): boolean;
  /** Executable name of a third-party app or of one of its extensions. */
  isAppProcess(name: string): boolean;
  /** Installed third-party app a bundle id belongs to: itself, or the host app of an app extension. */
  hostApp(bundleId: string): string | undefined;
  /**
   * Optional: keep a line of this process although it is no known app's? True while no process listing has
   * said what a third-party-looking process is (asks for one); see IosAppTracker.keepsUnknownProcess.
   */
  keepsUnknownProcess?(name: string): boolean;
}

/** System processes whose every line about an app concerns a crash or hang report. */
const CRASH_REPORTERS: ReadonlySet<string> = new Set(['ReportCrash', 'osanalyticshelper', 'spindump']);

/** System processes whose lines explain why an app was killed, crashed or hung. */
export const CRASH_RELEVANT_PROCESSES: ReadonlySet<string> = new Set([
  ...CRASH_REPORTERS,
  'SpringBoard',
  'runningboardd',
  'kernel',
  'launchd',
  'backboardd',
  'assertiond',
  'watchdogd',
]);

/**
 * Termination / crash wording in system lines ("termination reported by launchd", "Process exited",
 * "memorystatus: killing_specific_process", "exceeded mem limit", "scene-update watchdog transgression",
 * 0x8badf00d …), but not the routine "Set jetsam priority" / assertion / state updates.
 */
const TERMINATION_RE =
  /terminat|\bexit(?:ed|ing|s)?\b|\bcrash(?:ed|es|ing)?\b|\bkill|\bjetsam(?!\s*priority)|watchdog|transgression|\bSIG[A-Z]{3,}|EXC_|exception|\babort\(\)|corpse|exceeded|\bdied\b|launch failed|failed to launch|0x8badf00d|0xdead10cc|0xbaadca11|0xc00010ff|0xdeadfa11|0xbad22222/i;

/** Reverse-DNS tokens ("com.mykynk.pati", "com.x.app.NotificationService"). */
const BUNDLE_TOKEN = /[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+/g;
/** pids in the usual spots: "[1234]", "(1234)", ":1234]" / ":1234>", "pid 1234". */
const PID_TOKEN = /(?:[[(:]|\bpid[ =:]?)(\d{1,7})(?=[\])>\s,;]|$)/g;
/** Process names right before a pid ("Runner(1234)", "Runner[1234]") or in brackets ("[Runner]"). */
const NAME_BEFORE_PID = /([^\s:<>[\](){}"',;=|][^:<>[\](){}"',;=|]{0,63})[([]\d{1,7}[)\]]/g;
const NAME_IN_BRACKETS = /\[([^\][<>]{1,64})\]/g;
/** Crash report file names ("…/CrashReporter/MahalleNotificationService-2026-11-02-230022.ips"). */
const NAME_OF_REPORT = /(?:^|[\s/'"])([^/'"<>\s][^/'"<>]{0,63}?)-\d{4}-\d{2}-\d{2}-\d{6}/g;

/** Does a system line name a third-party app (bundle id, pid or process name)? */
export function mentionsThirdPartyApp(message: string, apps: ThirdPartyApps): boolean {
  for (const m of message.matchAll(BUNDLE_TOKEN)) if (apps.hostApp(m[0])) return true;
  for (const m of message.matchAll(PID_TOKEN)) {
    const pid = Number(m[1]);
    if (pid > 0 && apps.isAppPid(pid)) return true;
  }
  for (const re of [NAME_BEFORE_PID, NAME_IN_BRACKETS, NAME_OF_REPORT]) {
    for (const m of message.matchAll(re)) if (namedApp(m[1]!, apps)) return true;
  }
  return false;
}

/** "for pid 12 Runner" → tries the whole text, then "pid 12 Runner", "12 Runner", "Runner" (names may contain spaces). */
function namedApp(raw: string, apps: ThirdPartyApps): boolean {
  let s = raw.trim();
  while (s) {
    if (apps.isAppProcess(s)) return true;
    const sp = s.indexOf(' ');
    if (sp === -1) return false;
    s = s.slice(sp + 1).trimStart();
  }
  return false;
}

/** Is this parsed device line kept in the 'apps' scope? */
export function isAppScopedLine(entry: DeviceLogInput, apps: ThirdPartyApps): boolean {
  if (entry.kind === 'crash') return true;
  if (entry.pid !== undefined && entry.pid > 0 && apps.isAppPid(entry.pid)) return true;
  const process = entry.process;
  if (!process) return false;
  if (apps.isAppProcess(process)) return true;
  if (!CRASH_RELEVANT_PROCESSES.has(process)) return apps.keepsUnknownProcess?.(process) ?? false;
  if (!CRASH_REPORTERS.has(process) && !TERMINATION_RE.test(entry.message)) return false;
  return mentionsThirdPartyApp(entry.message, apps);
}

/**
 * Per-device gate in front of the log batcher. Header-less lines (no pid / process: a continuation that came
 * too late to be merged) follow the decision for the record before them.
 */
export class IosDeviceLogFilter {
  private lastKept = true;
  /** Lines kept / dropped since the session started (diagnostics, tests). */
  kept = 0;
  dropped = 0;

  constructor(
    private readonly apps: () => ThirdPartyApps | undefined,
    private readonly scope: () => IosDeviceLogScope,
  ) {}

  admit(entry: DeviceLogInput): boolean {
    const keep = this.decide(entry);
    if (keep) this.kept += 1;
    else this.dropped += 1;
    return keep;
  }

  private decide(entry: DeviceLogInput): boolean {
    if (this.scope() === 'all') return (this.lastKept = true);
    const apps = this.apps();
    // Apps not known yet (or no devicectl): nothing can be attributed, so nothing is hidden.
    if (!apps?.knowsApps) return (this.lastKept = true);
    if (entry.pid === undefined && !entry.process) return this.lastKept;
    return (this.lastKept = isAppScopedLine(entry, apps));
  }
}
