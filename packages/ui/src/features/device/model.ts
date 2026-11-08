/**
 * Device view model — pure helpers (no React, no stores): device facts, action parameter builders and
 * validation, app list merging, dumps and VM-service input detection.
 */
import type { AppActionDescriptor, AppSession, DeviceActionId, DeviceInfo, InstalledApp, ProcessUpdate } from '@durbun/protocol';

/* ───────────── Device facts ───────────── */

export function isReadOnlyDevice(d: Pick<DeviceInfo, 'id' | 'state'>): boolean {
  return d.id.startsWith('import:') || d.id === 'desktop' || d.state === 'disconnected';
}

export function hasAction(d: Pick<DeviceInfo, 'actions' | 'state'>, action: DeviceActionId): boolean {
  return d.state === 'online' && d.actions.includes(action);
}

export function hasAnyAction(d: Pick<DeviceInfo, 'actions' | 'state'>, actions: readonly DeviceActionId[]): boolean {
  return actions.some((a) => hasAction(d, a));
}

/**
 * Screen density as a scale factor. SPEC §9.4: drivers report a factor (2.625); values above 8 are treated
 * as dpi (some sources still report 420) and converted with the Android baseline of 160 dpi.
 */
export function densityScale(density: number | undefined): number | undefined {
  if (density === undefined || !Number.isFinite(density) || density <= 0) return undefined;
  return density > 8 ? Math.round((density / 160) * 1000) / 1000 : density;
}

/** "@2.6x", "@3x" (technical notation, same in every language). */
export function formatScale(scale: number): string {
  const r = Math.round(scale * 10) / 10;
  return `@${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}x`;
}

/** Logical size in dp / pt for a physical resolution and scale. */
export function logicalSize(screen: { width: number; height: number }, scale: number | undefined): { width: number; height: number } | undefined {
  if (!scale || scale <= 0) return undefined;
  return { width: Math.round(screen.width / scale), height: Math.round(screen.height / scale) };
}

export type BatteryBucket = 'full' | 'medium' | 'low';
export function batteryBucket(level: number): BatteryBucket {
  if (level >= 80) return 'full';
  if (level >= 25) return 'medium';
  return 'low';
}

/** Short OS line: "Android 15 · API 35", "iOS 18.2". */
export function osLine(d: Pick<DeviceInfo, 'platform' | 'osVersion' | 'apiLevel'>): string | undefined {
  const parts: string[] = [];
  if (d.platform === 'android') {
    if (d.osVersion) parts.push(`Android ${d.osVersion}`);
    if (d.apiLevel) parts.push(`API ${d.apiLevel}`);
  } else if (d.platform === 'ios') {
    if (d.osVersion) parts.push(`iOS ${d.osVersion}`);
  } else if (d.osVersion) parts.push(d.osVersion);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/* ───────────── Open URL ───────────── */

export type UrlProblem = 'empty' | 'spaces' | 'noScheme';

export function urlProblem(raw: string): UrlProblem | null {
  const url = raw.trim();
  if (!url) return 'empty';
  if (/\s/.test(url)) return 'spaces';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return 'noScheme';
  return null;
}

export function openUrlParams(url: string, appId?: string): Record<string, unknown> {
  const params: Record<string, unknown> = { url: url.trim() };
  if (appId && appId.trim()) params.appId = appId.trim();
  return params;
}

/** Most recent first, de-duplicated, capped. */
export function pushHistory(list: readonly string[], value: string, max = 15): string[] {
  const v = value.trim();
  if (!v) return list.slice(0, max);
  return [v, ...list.filter((x) => x !== v)].slice(0, max);
}

/* ───────────── Appearance ───────────── */

export const ANDROID_FONT_MIN = 0.5;
export const ANDROID_FONT_MAX = 2;
export const ANDROID_FONT_PRESETS: readonly { scale: number; key: 'small' | 'default' | 'large' | 'larger' | 'huge' | 'max' }[] = [
  { scale: 0.85, key: 'small' },
  { scale: 1, key: 'default' },
  { scale: 1.15, key: 'large' },
  { scale: 1.3, key: 'larger' },
  { scale: 1.5, key: 'huge' },
  { scale: 2, key: 'max' },
];

export function clampAndroidScale(v: number): number {
  if (!Number.isFinite(v)) return 1;
  const r = Math.round(v * 20) / 20;
  return Math.min(ANDROID_FONT_MAX, Math.max(ANDROID_FONT_MIN, r));
}

/** iOS Dynamic Type content size categories (simctl `ui content_size`), with the matching font scale. */
export const IOS_CONTENT_SIZES: readonly { id: string; scale: number }[] = [
  { id: 'extra-small', scale: 14 / 17 },
  { id: 'small', scale: 15 / 17 },
  { id: 'medium', scale: 16 / 17 },
  { id: 'large', scale: 1 },
  { id: 'extra-large', scale: 19 / 17 },
  { id: 'extra-extra-large', scale: 21 / 17 },
  { id: 'extra-extra-extra-large', scale: 23 / 17 },
  { id: 'accessibility-medium', scale: 28 / 17 },
  { id: 'accessibility-large', scale: 33 / 17 },
  { id: 'accessibility-extra-large', scale: 40 / 17 },
  { id: 'accessibility-extra-extra-large', scale: 47 / 17 },
  { id: 'accessibility-extra-extra-extra-large', scale: 53 / 17 },
];
export const IOS_DEFAULT_SIZE_INDEX = 3;

/** Font scale UI for a device: Android scale slider or iOS content size steps. */
export function fontScaleMode(d: Pick<DeviceInfo, 'platform'>): 'android' | 'ios' {
  return d.platform === 'ios' ? 'ios' : 'android';
}

/**
 * `font-scale` params. Android: `{ scale }` (0.5–2.0, 0.05 steps). iOS simulator: the content size category
 * (`contentSize`, understood by the simulator driver) plus its scale, capped at 3 for drivers that only read
 * `scale` (the nearest category of 3 is still the largest one).
 */
export function fontScaleParams(mode: 'android' | 'ios', value: number): Record<string, unknown> {
  if (mode === 'android') return { scale: clampAndroidScale(value) };
  const i = Math.min(IOS_CONTENT_SIZES.length - 1, Math.max(0, Math.round(value)));
  const size = IOS_CONTENT_SIZES[i]!;
  return { scale: Math.min(3, Math.round(size.scale * 1000) / 1000), contentSize: size.id };
}

/* ───────────── Input ───────────── */

export const ANDROID_KEYS = ['home', 'back', 'recents', 'menu', 'enter', 'delete', 'volume-down', 'volume-up', 'power'] as const;
export type AndroidKey = (typeof ANDROID_KEYS)[number];

/** Characters adb `input text` cannot type (anything outside printable ASCII and newlines). */
export function nonAsciiChars(text: string): string[] {
  const out = new Set<string>();
  for (const ch of text) if (!/[\x20-\x7E\n]/.test(ch)) out.add(ch);
  return [...out];
}

/* ───────────── Location ───────────── */

export const LOCATION_PRESETS: readonly { id: string; lat: number; lon: number }[] = [
  { id: 'istanbul', lat: 41.0082, lon: 28.9784 },
  { id: 'ankara', lat: 39.9334, lon: 32.8597 },
  { id: 'izmir', lat: 38.4237, lon: 27.1428 },
  { id: 'antalya', lat: 36.8969, lon: 30.7133 },
  { id: 'london', lat: 51.5074, lon: -0.1278 },
  { id: 'sanFrancisco', lat: 37.7749, lon: -122.4194 },
  { id: 'tokyo', lat: 35.6762, lon: 139.6503 },
];

/** "41.0082", "41,0082" (Turkish decimal comma), " -0.1278 " → number. */
export function parseCoordinate(text: string): number | undefined {
  const s = text.trim().replace(/\s+/g, '');
  if (!s) return undefined;
  const normalized = /^-?\d+,\d+$/.test(s) ? s.replace(',', '.') : s;
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return undefined;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

/** A pasted pair: "41.0082, 28.9784", "41.0082 28.9784", "41,0082; 28,9784". */
export function parseCoordinatePair(text: string): { lat: number; lon: number } | undefined {
  const s = text.trim();
  const m = /^(-?\d+(?:[.,]\d+)?)\s*[;,\s]\s*(-?\d+(?:[.,]\d+)?)$/.exec(s);
  if (!m) return undefined;
  const lat = parseCoordinate(m[1]!);
  const lon = parseCoordinate(m[2]!);
  if (lat === undefined || lon === undefined) return undefined;
  return { lat, lon };
}

export function validateLocation(latText: string, lonText: string): { lat: number; lon: number } | { error: 'lat' | 'lon' } {
  const lat = parseCoordinate(latText);
  if (lat === undefined || Math.abs(lat) > 90) return { error: 'lat' };
  const lon = parseCoordinate(lonText);
  if (lon === undefined || Math.abs(lon) > 180) return { error: 'lon' };
  return { lat, lon };
}

/* ───────────── Push notification ───────────── */

export const PUSH_MAX_BYTES = 4096;

export const APNS_TEMPLATES = {
  alert: {
    aps: {
      alert: { title: 'Dürbün', subtitle: 'Test bildirimi', body: 'Merhaba! Bu bildirim Dürbün’den gönderildi.' },
      sound: 'default',
      badge: 1,
    },
    deeplink: 'myapp://home',
  },
  silent: {
    aps: { 'content-available': 1 },
    type: 'sync',
  },
  badge: {
    aps: { badge: 3 },
  },
} as const;
export type PushTemplate = keyof typeof APNS_TEMPLATES;

/** The alert template's visible texts per UI language (the payload goes to the user's own app). */
const ALERT_TEXTS = {
  tr: { subtitle: 'Test bildirimi', body: 'Merhaba! Bu bildirim Dürbün’den gönderildi.' },
  en: { subtitle: 'Test notification', body: 'Hello! This notification was sent from Dürbün.' },
} as const;

export function templateText(name: PushTemplate, lang: 'tr' | 'en' = 'tr'): string {
  if (name !== 'alert') return JSON.stringify(APNS_TEMPLATES[name], null, 2);
  const tpl = APNS_TEMPLATES.alert;
  return JSON.stringify({ ...tpl, aps: { ...tpl.aps, alert: { ...tpl.aps.alert, ...ALERT_TEXTS[lang] } } }, null, 2);
}

export type PushValidation =
  | { ok: true; payload: Record<string, unknown>; bytes: number }
  | { ok: false; error: 'json'; message: string }
  | { ok: false; error: 'notObject' | 'noAps' }
  | { ok: false; error: 'tooLarge'; bytes: number };

function utf8Length(text: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : unescape(encodeURIComponent(text)).length;
}

/** Same checks as the simulator driver: a JSON object with an "aps" object, ≤ 4096 bytes when minified. */
export function validatePush(text: string): PushValidation {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: 'json', message: err instanceof Error ? err.message : String(err) };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'notObject' };
  const aps = (value as Record<string, unknown>).aps;
  if (!aps || typeof aps !== 'object' || Array.isArray(aps)) return { ok: false, error: 'noAps' };
  const bytes = utf8Length(JSON.stringify(value));
  if (bytes > PUSH_MAX_BYTES) return { ok: false, error: 'tooLarge', bytes };
  return { ok: true, payload: value as Record<string, unknown>, bytes };
}

/* ───────────── Screen recording ───────────── */

/**
 * How long a recording may run before it stops by itself (s): Android's `screenrecord` stops at 180 s, the
 * server stops iOS recordings at 600 s. A running recording reports its own `DeviceInfo.recording.limitSec`.
 */
export function recordLimitSec(d: Pick<DeviceInfo, 'platform'>): number {
  return d.platform === 'android' ? 180 : 600;
}

/** Stopwatch text: 0:07, 2:41, 10:00. */
export function recordClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Validate the `screen-record` / `screen-record-stop` reply data. */
export function recordResult(data: unknown): { url: string; file?: string; durationSec?: number; endedBy?: 'stop' | 'limit' } | null {
  const m = mediaResult(data);
  if (!m) return null;
  const r = data as Record<string, unknown>;
  const out: { url: string; file?: string; durationSec?: number; endedBy?: 'stop' | 'limit' } = { url: m.url };
  if (m.file) out.file = m.file;
  if (typeof r.durationSec === 'number' && r.durationSec > 0) out.durationSec = r.durationSec;
  if (r.endedBy === 'stop' || r.endedBy === 'limit') out.endedBy = r.endedBy;
  return out;
}

/** Simulator recordings are QuickTime (.mov); Android and iOS devices produce .mp4. */
export function recordingExtension(d: Pick<DeviceInfo, 'kind'>): 'mov' | 'mp4' {
  return d.kind === 'simulator' ? 'mov' : 'mp4';
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function mediaFileName(kind: 'screenshot' | 'recording', d: Pick<DeviceInfo, 'kind' | 'name'>, ts: number, serverPath?: string): string {
  if (serverPath) return baseName(serverPath);
  const slug =
    d.name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'device';
  const ext = kind === 'screenshot' ? 'png' : recordingExtension(d);
  return `${kind}-${slug}-${stamp(ts)}.${ext}`;
}

/** Validate the `screenshot` / `screen-record` reply data. */
export function mediaResult(data: unknown): { url: string; file?: string; width?: number; height?: number } | null {
  if (!data || typeof data !== 'object') return null;
  const r = data as Record<string, unknown>;
  if (typeof r.url !== 'string' || !r.url) return null;
  const out: { url: string; file?: string; width?: number; height?: number } = { url: r.url };
  if (typeof r.file === 'string') out.file = r.file;
  if (typeof r.width === 'number' && r.width > 0) out.width = r.width;
  if (typeof r.height === 'number' && r.height > 0) out.height = r.height;
  return out;
}

/* ───────────── App install ───────────── */

export type InstallTarget = 'android' | 'ios-sim' | 'ios-device';

export function installTarget(d: Pick<DeviceInfo, 'platform' | 'kind'>): InstallTarget {
  if (d.platform === 'ios') return d.kind === 'simulator' ? 'ios-sim' : 'ios-device';
  return 'android';
}

const ACCEPT: Record<InstallTarget, string[]> = {
  android: ['.apk'],
  'ios-sim': ['.app', '.zip'],
  'ios-device': ['.ipa', '.zip'],
};

export function installAccept(target: InstallTarget): string {
  return ACCEPT[target].join(',');
}

export type InstallCheck = { ok: true } | { ok: false; reason: 'aab' | 'wrongPlatform' | 'unknownType' | 'empty' };

export function fileExtension(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? `.${m[1]!.toLowerCase()}` : '';
}

export function checkInstallFile(file: { name: string; size: number }, target: InstallTarget): InstallCheck {
  const ext = fileExtension(file.name);
  if (ACCEPT[target].includes(ext)) return file.size > 0 ? { ok: true } : { ok: false, reason: 'empty' };
  if (ext === '.aab') return { ok: false, reason: 'aab' };
  if (['.apk', '.ipa', '.app', '.zip', '.xapk', '.apks'].includes(ext)) return { ok: false, reason: 'wrongPlatform' };
  return { ok: false, reason: 'unknownType' };
}

/* ───────────── Apps (list-apps + SDK sessions) ───────────── */

export interface AppRow {
  id: string;
  name: string;
  version?: string;
  system: boolean;
  debuggable: boolean;
  /** An SDK session of this app was seen on the device. */
  sdk: boolean;
  /** An SDK session is connected right now. */
  connected: boolean;
  /** Reported by list-apps (false: known only from an SDK session). */
  listed: boolean;
}

export function parseInstalledApps(data: unknown): InstalledApp[] {
  if (!Array.isArray(data)) return [];
  const out: InstalledApp[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (typeof a.id !== 'string' || !a.id) continue;
    out.push({
      id: a.id,
      name: typeof a.name === 'string' && a.name ? a.name : undefined,
      version: typeof a.version === 'string' && a.version ? a.version : undefined,
      debuggable: a.debuggable === true,
      system: a.system === true,
    });
  }
  return out;
}

/** Installed apps merged with SDK apps of the device: user apps first (connected SDK apps on top), then system apps. */
export function mergeApps(installed: readonly InstalledApp[] | undefined, sessions: readonly AppSession[]): AppRow[] {
  const rows = new Map<string, AppRow>();
  for (const a of installed ?? []) {
    rows.set(a.id, {
      id: a.id,
      name: a.name || a.id,
      version: a.version,
      system: a.system === true,
      debuggable: a.debuggable === true,
      sdk: false,
      connected: false,
      listed: true,
    });
  }
  for (const s of sessions) {
    const id = s.app.id;
    const row = rows.get(id);
    if (row) {
      row.sdk = true;
      row.connected ||= s.connected;
      if (!row.version && s.app.version) row.version = s.app.version;
      if (row.name === row.id && s.app.name) row.name = s.app.name;
      if (s.app.debug) row.debuggable = true;
    } else {
      rows.set(id, {
        id,
        name: s.app.name || id,
        version: s.app.version,
        system: false,
        debuggable: s.app.debug === true,
        sdk: true,
        connected: s.connected,
        listed: false,
      });
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      Number(a.system) - Number(b.system) ||
      Number(b.connected) - Number(a.connected) ||
      Number(b.sdk) - Number(a.sdk) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}

export function filterApps(rows: readonly AppRow[], query: string): AppRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows.slice();
  return rows.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
}

/* ───────────── App actions (AppSession.actions) ───────────── */

export const BUILTIN_APP_ACTIONS: ReadonlySet<string> = new Set([
  'flutter.debugPaint',
  'flutter.repaintRainbow',
  'flutter.slowAnimations',
  'flutter.performanceOverlay',
  'flutter.invertOversizedImages',
  'flutter.brightness',
  'flutter.platform',
  'flutter.dumpWidgetTree',
  'flutter.dumpRenderTree',
  'android.dumpThreads',
  'android.gc',
  'ios.appearance',
  'ios.slowAnimations',
  'ios.dumpViewHierarchy',
  'ios.dumpUserDefaults',
  'rn.reload',
  'rn.devMenu',
  'web.reload',
]);

/** i18n key suffix for a built-in action (labelKey === id for built-ins, SPEC §9.4); undefined for custom ones. */
export function builtinLabelId(a: Pick<AppActionDescriptor, 'id' | 'labelKey'>): string | undefined {
  if (BUILTIN_APP_ACTIONS.has(a.id)) return a.id;
  if (a.labelKey && BUILTIN_APP_ACTIONS.has(a.labelKey)) return a.labelKey;
  return undefined;
}

export const ACTION_GROUP_ORDER = ['flutter', 'android', 'ios', 'react-native', 'web', 'app'] as const;

export function actionGroups(actions: readonly AppActionDescriptor[]): { group: string; actions: AppActionDescriptor[] }[] {
  const map = new Map<string, AppActionDescriptor[]>();
  for (const a of actions) {
    const g = a.group || 'app';
    const list = map.get(g);
    if (list) list.push(a);
    else map.set(g, [a]);
  }
  const order = (g: string) => {
    const i = (ACTION_GROUP_ORDER as readonly string[]).indexOf(g);
    return i < 0 ? ACTION_GROUP_ORDER.length : i;
  };
  return [...map.entries()].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0])).map(([group, list]) => ({ group, actions: list }));
}

/** `app.action` params (SPEC §9.4): toggles and selects send `{ value }`, buttons `{}`. */
export function appActionParams(a: Pick<AppActionDescriptor, 'kind'>, value?: boolean | string): Record<string, unknown> {
  if (a.kind === 'button') return {};
  if (a.kind === 'toggle') return { value: value === true };
  return { value: typeof value === 'string' ? value : '' };
}

/* ───────────── Dumps ───────────── */

export const DUMP_TITLES: Record<string, readonly string[]> = {
  'flutter.dumpWidgetTree': ['Widget tree', '[root]'],
  'flutter.dumpRenderTree': ['Render tree', 'RenderView'],
  'android.dumpThreads': ['Thread dump'],
  'ios.dumpViewHierarchy': ['View hierarchy', '<UIWindow'],
  'ios.dumpUserDefaults': ['UserDefaults'],
};

export function isDumpAction(id: string): boolean {
  return id in DUMP_TITLES || /dump/i.test(id);
}

/** `{ text, lines }` from a dump reply (text may be missing — then the dump is only in the logs). */
export function dumpReply(data: unknown): { text?: string; lines?: number } {
  if (typeof data === 'string') return { text: data, lines: data.split('\n').length };
  if (!data || typeof data !== 'object') return {};
  const r = data as Record<string, unknown>;
  const text = typeof r.text === 'string' && r.text ? r.text : undefined;
  const lines = typeof r.lines === 'number' && r.lines > 0 ? r.lines : text ? text.split('\n').length : undefined;
  return { text, lines };
}

/** Does this log message look like the dump an action just produced? */
export function isDumpMessage(message: string, actionId: string, expectedLines?: number): boolean {
  const lines = message.split('\n').length;
  if (lines < 3) return false;
  const head = message.trimStart();
  if ((DUMP_TITLES[actionId] ?? []).some((p) => head.startsWith(p))) return true;
  return expectedLines !== undefined && Math.abs(lines - expectedLines) <= 2;
}

/* ───────────── Dart VM Service ───────────── */

const VM_URL = /\b((?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0|\d{1,3}(?:\.\d{1,3}){3}):\d{2,5}\/[^\s"'<>]*)/i;

/** The first VM service / DevTools URL in pasted text (best-effort hint; the server does the real parsing). */
export function findVmUrl(text: string): string | undefined {
  const m = VM_URL.exec(text);
  if (!m) return undefined;
  const url = m[1]!.replace(/[).,;]+$/, '');
  try {
    const u = new URL(url);
    const inner = u.searchParams.get('uri');
    if (inner) return decodeURIComponent(inner);
  } catch {
    /* keep the raw match */
  }
  return url;
}

/* ───────────── Processes ───────────── */

export interface ProcessRow {
  pid: number;
  name: string;
  event: ProcessUpdate['event'];
  ts: number;
  /** SDK app whose session runs in this process. */
  appName?: string;
}

export function processRows(
  byPid: Record<number, ProcessUpdate> | undefined,
  sessions: readonly AppSession[],
  query: string,
  showDied: boolean,
): { rows: ProcessRow[]; total: number; died: number } {
  const appByPid = new Map<number, string>();
  for (const s of sessions) if (typeof s.app.pid === 'number' && s.connected) appByPid.set(s.app.pid, s.app.name || s.app.id);
  const q = query.trim().toLowerCase();
  const all = Object.values(byPid ?? {});
  let died = 0;
  const rows: ProcessRow[] = [];
  for (const p of all) {
    if (p.event === 'died') died++;
    if (!showDied && p.event === 'died') continue;
    if (q && !p.name.toLowerCase().includes(q) && !String(p.pid).startsWith(q)) continue;
    rows.push({ pid: p.pid, name: p.name, event: p.event, ts: p.ts, appName: appByPid.get(p.pid) });
  }
  rows.sort((a, b) => Number(Boolean(b.appName)) - Number(Boolean(a.appName)) || Number(a.event === 'died') - Number(b.event === 'died') || a.name.localeCompare(b.name) || a.pid - b.pid);
  return { rows, total: all.length, died };
}
