import type { ToolCheck } from '@durbun/protocol';
import { hasMessage, t } from '../i18n/core';
import { hasCode, tCode } from '../i18n/codes';

/**
 * Localized text for the server's `ToolCheck`s ("Sistem kontrolü"). The server sends English labels, details
 * and fixes; ids are stable (packages/server/src/doctor.ts + every driver's `checks()`):
 *   node · data-dir · ui-build · port-http · port-sdk · adb · simctl · usbmuxd · idevicesyslog · devicectl ·
 *   idevicescreenshot · flutter-vm · driver-<id> (driver failed to start) · driver-<id>-checks /
 *   flutter-vm-checks (checks threw or timed out).
 * Unknown ids and unrecognized details fall back to the server's English text.
 */

/** Looks like a shell command (copyable as code) rather than an English sentence. */
export function isCommand(fix: string): boolean {
  const s = fix.trim();
  if (/^(brew|npm|npx|xcode-select|sudo|export|adb|xcrun|flutter|dart|sdkmanager|open|echo|mkdir|ln|chmod|pod|gem|curl|lsof|durbun)\b/.test(s)) return true;
  return !/\s[a-z]+\s[a-z]+\s[a-z]+/i.test(s) || s.includes(' && ');
}

const DRIVER_IDS = new Set(['android', 'ios-sim', 'ios-device', 'flutter-vm', 'demo']);

function driverName(id: string): string {
  return DRIVER_IDS.has(id) ? t(`shell.doctor.drivers.${id}`) : id;
}

function portOf(c: ToolCheck): string {
  return /:(\d+)$/.exec(c.path ?? '')?.[1] ?? /(\d+)\s*$/.exec(c.label)?.[1] ?? '';
}

/** Localized label of a check. */
export function checkLabel(c: ToolCheck): string {
  const id = c.id;
  if (id === 'port-http' || id === 'port-sdk') return t(`shell.doctor.labels.${id}`, { port: portOf(c) });
  let m = /^(?:driver-)?(.+?)-checks$/.exec(id);
  if (m && DRIVER_IDS.has(m[1]!)) return t('shell.doctor.labels.driverChecks', { driver: driverName(m[1]!) });
  m = /^driver-(.+)$/.exec(id);
  if (m) return t('shell.doctor.labels.driver', { driver: driverName(m[1]!) });
  const key = `shell.doctor.labels.${id}`;
  return hasMessage(key) ? t(key) : c.label;
}

type Detail = [pattern: RegExp, key: string, params?: (m: RegExpExecArray) => Record<string, string | number>];

const yesNo = (v: string | undefined) => t(v === 'yes' ? 'shell.doctor.detail.yes' : 'shell.doctor.detail.no');

const DETAILS: Detail[] = [
  [/^Listening on (.+)$/, 'listening', (m) => ({ addr: m[1]! })],
  [/^Available$/, 'available'],
  [/^Port (\d+) is (?:already )?used by another program$/, 'portInUse', (m) => ({ port: m[1]! })],
  [/^Could not test port (\d+)$/, 'portUntested', (m) => ({ port: m[1]! })],
  [/^Could not listen on (\S+?): (.+)$/, 'cannotListen', (m) => ({ addr: m[1]!, error: m[2]! })],
  [/^Dürbün needs Node\.js (\d+) or newer$/, 'nodeTooOld', (m) => ({ major: m[1]! })],
  [/^Not writable: (.+)$/, 'notWritable', (m) => ({ error: m[1]! })],
  [/^No built UI found/, 'noUiBuild'],
  [/^from settings(?:\.adbPath)?$/, 'fromSettings'],
  [/^from \$ANDROID_HOME \/ \$ANDROID_SDK_ROOT$/, 'fromAndroidHome'],
  [/^from ~\/Library\/Android\/sdk$/, 'fromAndroidSdk'],
  [/^from path$/i, 'fromPath'],
  [/^from Flutter ?(\S*) cache \((.+?)\)(?: · .*)?$/, 'fromFlutterCache', (m) => ({ version: m[1] ?? '' })],
  [/^Configured (?:adbPath|idevicesyslogPath) "(.+)" is not an executable file$/, 'badConfiguredPath', (m) => ({ path: m[1]! })],
  [/^adb not found \(/, 'adbNotFound'],
  [/^(.+) exists but "adb version" failed$/, 'adbVersionFailed', (m) => ({ path: m[1]! })],
  [/^(\d+) booted simulator\(s\)$/, 'bootedSimulators', (m) => ({ count: Number(m[1]) })],
  [/^Xcode is not installed or not selected$/, 'xcodeMissing'],
  [/^Only the Command Line Tools are selected/, 'cltOnly'],
  [/^xcrun not found$/, 'xcrunMissing'],
  [/^No Xcode developer directory selected/, 'noDeveloperDir'],
  [/^xcrun cannot find simctl \((.+)\)$/, 'simctlNotFound', (m) => ({ dir: m[1]! })],
  [/^Xcode tools are only available on macOS$/, 'macOnly'],
  [/^(\d+) device\(s\) attached$/, 'devicesAttached', (m) => ({ count: Number(m[1]) })],
  [/^idevicesyslog was not found/, 'syslogMissing'],
  [/^idevicesyslog failed to run: (.*)$/, 'syslogFailed', (m) => ({ error: m[1]! })],
  [/^screenshot: (yes|no) · screen recording: (yes|no)$/, 'devicectlCaps', (m) => ({ shot: yesNo(m[1]), rec: yesNo(m[2]) })],
  [/^Install Xcode 15 or newer/, 'devicectlMissing'],
  [/^not needed \(devicectl captures screenshots\)$/, 'screenshotNotNeeded'],
  [/^not found$/, 'notFound'],
  [
    /^(\d+) attached(?: \((.+)\))? · auto-attach (on|off)/,
    'vmStatus',
    (m) => ({ count: Number(m[1]), names: m[2] ?? '', auto: t(m[3] === 'on' ? 'shell.doctor.detail.autoOn' : 'shell.doctor.detail.autoOff') }),
  ],
  [/^Checks failed: (.*)$/, 'checksFailed', (m) => ({ error: m[1]! })],
  [/^(?:The \S+ driver failed to initialize|Failed to initialize): (.*)$/, 'initFailed', (m) => ({ error: m[1]! })],
];

/** Message keys (under `shell.doctor.detail.`) the recognized details map to — for completeness tests. */
export const DOCTOR_DETAIL_KEYS: readonly string[] = DETAILS.map(([, key]) => key);

/**
 * Localized detail of a check: its i18n code when the UI knows it (e.g. 'doctor.node.embedded' {electron, node}),
 * else a recognized English detail, else the server's English text.
 */
export function checkDetail(c: Pick<ToolCheck, 'detail' | 'code' | 'params'>): string | undefined {
  const detail = c.detail?.trim();
  if (c.code && hasCode(c.code)) return tCode(c.code, c.params, detail || c.code);
  if (!detail) return undefined;
  for (const [re, key, params] of DETAILS) {
    const m = re.exec(detail);
    if (m) return t(`shell.doctor.detail.${key}`, params?.(m));
  }
  return detail;
}

export interface CheckFix {
  /** What to do, in words (localized). */
  text?: string;
  /** Shell command to copy. */
  command?: string;
}

/** Fix sentences the server sends (English) → message keys. */
const FIX_TEXT: Record<string, string> = {
  'Install Xcode from the App Store': 'installXcode',
  'Install and start usbmuxd': 'installUsbmuxd',
};

/** Short lead-in shown above some fix commands. */
function commandHint(command: string): string | undefined {
  if (/^lsof\b/.test(command)) return t('shell.doctor.fix.whoUsesPort');
  if (/^npm run build\b/.test(command)) return t('shell.doctor.fix.buildUi');
  if (/^durbun --data-dir\b/.test(command)) return t('shell.doctor.fix.dataDir');
  if (/^sudo killall -HUP usbmuxd\b/.test(command)) return t('shell.doctor.fix.restartUsbmuxd');
  if (/^sudo xcode-select\b/.test(command)) return t('shell.doctor.fix.selectXcode');
  return undefined;
}

function fixText(text: string): string {
  const key = FIX_TEXT[text.trim().replace(/[.,:]+$/, '')];
  return key ? t(`shell.doctor.fix.${key}`) : text;
}

/** Localized fix: words and/or a copyable command ("Install Xcode…, then: sudo xcode-select -s …" → both). */
export function checkFix(c: Pick<ToolCheck, 'fix'>): CheckFix | undefined {
  const fix = c.fix?.trim();
  if (!fix) return undefined;
  const then = /^(.*?),?\s+then:\s*(\S.*)$/i.exec(fix);
  if (then) return { text: `${fixText(then[1]!)}${t('shell.doctor.fix.then')}`, command: then[2]!.trim() };
  if (isCommand(fix)) return { text: commandHint(fix), command: fix };
  return { text: fixText(fix) };
}
