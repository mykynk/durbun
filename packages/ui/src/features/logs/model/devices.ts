import type { LogEntry } from '@durbun/protocol';
import { hashHue } from '../../../lib/hash';
import type { DeviceMark } from '../components/LogRow';

/** Distinct hues for the device markers of a multi-device list (blue, green, violet, orange, pink, cyan, lime, indigo). */
const DEVICE_HUES = [212, 152, 272, 32, 328, 188, 96, 246];

/** Chip label: "iPhone 13 · Demo" → "iPhone 13" (every demo device has the suffix; the tooltip keeps it). */
export function shortDeviceName(name: string): string {
  return name.replace(/\s*·\s*Demo$/, '') || name;
}

/**
 * Stable marker per device: its preferred palette slot (hash of the id), the next free one on a collision.
 * Ids are taken in sorted order so the same set of devices always gets the same colors.
 */
export function deviceMarks(devices: readonly { id: string; name: string }[]): Map<string, DeviceMark> {
  const out = new Map<string, DeviceMark>();
  const used = new Set<number>();
  for (const d of [...devices].sort((a, b) => a.id.localeCompare(b.id))) {
    let slot = hashHue(d.id) % DEVICE_HUES.length;
    for (let i = 0; i < DEVICE_HUES.length && used.has(slot); i++) slot = (slot + 1) % DEVICE_HUES.length;
    used.add(slot);
    out.set(d.id, { name: d.name, short: shortDeviceName(d.name), hue: DEVICE_HUES[slot]! });
  }
  return out;
}

/**
 * System processes whose iPhone lines the server keeps in its 'apps' scope only when they concern a third-party
 * app's crash, kill or hang (packages/server/src/platform/ios/deviceLogScope.ts CRASH_RELEVANT_PROCESSES).
 */
const CRASH_RELEVANT_IOS_PROCESSES: ReadonlySet<string> = new Set(['ReportCrash', 'osanalyticshelper', 'spindump', 'SpringBoard', 'runningboardd', 'kernel', 'launchd', 'backboardd', 'assertiond', 'watchdogd']);
/** Of those, the crash / hang reporters: everything they say about an app is about a report. */
const IOS_CRASH_REPORTERS: ReadonlySet<string> = new Set(['ReportCrash', 'osanalyticshelper', 'spindump']);
/** What a daemon line must say to be kept: a termination, exit, kill, jetsam, watchdog… (server TERMINATION_RE). */
const TERMINATION_RE =
  /terminat|\bexit(?:ed|ing|s)?\b|\bcrash(?:ed|es|ing)?\b|\bkill|\bjetsam(?!\s*priority)|watchdog|transgression|\bSIG[A-Z]{3,}|EXC_|exception|\babort\(\)|corpse|exceeded|\bdied\b|launch failed|failed to launch|0x8badf00d|0xdead10cc|0xbaadca11|0xc00010ff|0xdeadfa11|0xbad22222/i;

/** An iPhone daemon line of the kind the server's 'apps' scope keeps on purpose (it says why an app died). */
export function isCrashRelevantIosLine(e: Pick<LogEntry, 'origin' | 'process' | 'message'>): boolean {
  if (e.origin !== 'idevicesyslog' || !e.process || !CRASH_RELEVANT_IOS_PROCESSES.has(e.process)) return false;
  return IOS_CRASH_REPORTERS.has(e.process) || TERMINATION_RE.test(e.message);
}

/**
 * Noise predicate that never hides what the server's iPhone 'apps' scope kept on purpose: in that scope a kernel /
 * runningboardd / backboardd … line that says why an app died ("killing_specific_process", "termination reported
 * by launchd") is there for that reason, even though those daemons are noise rules. Their routine chatter (which
 * the server passes while it does not know the phone's apps yet) stays hideable.
 */
export function keepCrashRelevant<E extends Pick<LogEntry, 'origin' | 'process' | 'message'>>(noise: (e: E) => boolean, iosAppsScope: boolean): (e: E) => boolean {
  if (!iosAppsScope) return noise;
  return (e) => !isCrashRelevantIosLine(e) && noise(e);
}
