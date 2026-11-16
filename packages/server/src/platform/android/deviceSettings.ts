/**
 * Android settings Dürbün changes for a tester (dark mode, font scale, animations, airplane mode, Wi-Fi, mobile
 * data, rotation, "Don't keep activities", an app's permission or language). Before Dürbün's first change the
 * current value is read and kept (`SettingOverrides`, DeviceInfo.settingOverrides), so `{ restore: true }` puts
 * it back; a change back to that value forgets it. Every value written comes from a fixed set or was parsed
 * strictly from the phone's own output, and every shell argument from params is validated or quoted.
 */
import type { DeviceActionId, DeviceActionResult, DeviceSettingOverride, DeviceUser } from '@durbun/protocol';
import { failureText, type RunResult } from '../exec';
import { bool, done, fail, num, str, validAppId } from '../shared/files';
import { shellQuote } from '../shared/text';
import type { Adb } from './adb';
import { userFlag, userParam } from './users';

/** Which setting of an action an override is about (per-app settings: the app, and the permission). */
export interface OverrideScope {
  appId?: string;
  key?: string;
}

export interface SettingOverrides {
  get(action: DeviceActionId, scope?: OverrideScope): DeviceSettingOverride | undefined;
  set(override: DeviceSettingOverride): void;
  delete(action: DeviceActionId, scope?: OverrideScope): void;
}

/** Map key of an override: the action, plus app and permission for per-app settings. */
export function overrideKey(action: DeviceActionId, scope?: OverrideScope): string {
  return scope?.appId || scope?.key ? `${action}|${scope.appId ?? ''}|${scope.key ?? ''}` : action;
}

export interface SettingTarget {
  adb: Pick<Adb, 'shell'>;
  serial: string;
  apiLevel?: number;
  overrides?: SettingOverrides;
  users?: readonly DeviceUser[];
}

export const SETTING_ACTIONS: ReadonlySet<DeviceActionId> = new Set<DeviceActionId>([
  'appearance',
  'font-scale',
  'animations',
  'airplane-mode',
  'wifi',
  'mobile-data',
  'rotation',
  'dont-keep-activities',
  'app-permission',
  'app-locale',
]);

const ANIMATION_KEYS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'] as const;
/** `settings get` of a key nobody set prints "null": the platform default applies. */
const DEFAULT_VALUE = 'default';

const ROTATIONS = ['portrait', 'landscape', 'reverse-portrait', 'reverse-landscape'] as const;
const PERMISSION_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/;

/** One `settings get` line → value ("default" for an unset key), undefined when unreadable. */
export function settingValue(line: string | undefined): string | undefined {
  const v = line?.trim();
  if (!v) return undefined;
  if (v === 'null') return DEFAULT_VALUE;
  return /^-?\d+(\.\d+)?$/.test(v) ? String(Number(v)) : undefined;
}

/** "1,1,1" → "1"; differing scales stay a list (window,transition,animator). */
function joinScales(values: string[]): string {
  return values.every((v) => v === values[0]) ? values[0]! : values.join(',');
}

/** `cmd uimode night` → "yes" | "no" | "auto" (other modes, such as a custom schedule, cannot be set back). */
export function parseNightMode(text: string): string | undefined {
  const v = /Night mode:\s*(\w+)/i.exec(text)?.[1]?.toLowerCase();
  return v === 'yes' || v === 'no' || v === 'auto' ? v : undefined;
}

/** `cmd connectivity airplane-mode` → 'on' | 'off'. */
export function parseAirplaneMode(text: string): 'on' | 'off' | undefined {
  const v = text.trim().split('\n')[0]?.trim();
  return v === 'enabled' ? 'on' : v === 'disabled' ? 'off' : undefined;
}

/** `settings get global wifi_on`: 1 on, 2 on (kept on in airplane mode), 0 off, 3 off (airplane mode turned it off). */
export function parseWifiOn(text: string): 'on' | 'off' | undefined {
  const v = text.trim().split('\n')[0]?.trim();
  return v === '1' || v === '2' ? 'on' : v === '0' || v === '3' ? 'off' : undefined;
}

/** `settings get system accelerometer_rotation; settings get system user_rotation` → 'auto' or a fixed rotation. */
export function parseRotation(text: string): string | undefined {
  const [accel, user] = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (accel === '1') return 'auto';
  if (accel !== '0') return undefined;
  if (user === undefined || user === 'null') return ROTATIONS[0];
  return /^[0-3]$/.test(user) ? ROTATIONS[Number(user)] : undefined;
}

/**
 * State of one runtime permission in `dumpsys package <pkg>` ("android.permission.CAMERA: granted=false,
 * flags=[ USER_SET ]" under "runtime permissions:" of each "User <id>:" section). Without a user id the first
 * section counts (the default user comes first).
 */
export function parseRuntimePermission(text: string, permission: string, userId?: number): 'granted' | 'denied' | undefined {
  let user: number | undefined;
  for (const line of text.split('\n')) {
    const u = /^\s*User (\d+):/.exec(line);
    if (u) {
      user = Number(u[1]);
      continue;
    }
    if (userId !== undefined && user !== userId) continue;
    const t = line.trim();
    if (!t.startsWith(`${permission}: granted=`)) continue;
    const v = /^\S+: granted=(true|false)\b/.exec(t)?.[1];
    if (v) return v === 'true' ? 'granted' : 'denied';
  }
  return undefined;
}

/** `cmd locale get-app-locales <pkg>` → "Locales for <pkg> for user 0 are [tr-TR]" → 'tr-TR' ('system' for []). */
export function parseAppLocales(text: string): string | undefined {
  const m = /Locales for \S+ for user \d+ are \[([^\]]*)\]/.exec(text);
  if (!m) return undefined;
  const v = m[1]!.trim();
  if (!v) return 'system';
  return v.split(',').every((tag) => LOCALE_RE.test(tag.trim())) ? v.replace(/\s+/g, '') : undefined;
}

/** Shell command that sets a setting to `value` (unset keys are deleted, so the platform default applies again). */
function putSetting(namespace: 'global' | 'system', key: string, value: string): string {
  return value === DEFAULT_VALUE ? `settings delete ${namespace} ${key}` : `settings put ${namespace} ${key} ${value}`;
}

function textOf(r: { stdout: string; stderr: string }): string {
  return `${r.stdout}\n${r.stderr}`.trim();
}

interface SettingIo {
  label: string;
  scope?: OverrideScope;
  read(): Promise<string | undefined>;
  write(value: string): Promise<DeviceActionResult | undefined>;
  /** The value the params ask for and the reply text, or why the params are wrong. */
  wanted(): { value: string; message: string } | DeviceActionResult;
}

const isResult = (v: unknown): v is DeviceActionResult => typeof v === 'object' && v !== null && 'ok' in v;

function onOff(params: Record<string, unknown>, label: string): { value: string; message: string } | DeviceActionResult {
  const enabled = bool(params, 'enabled');
  if (enabled === undefined) return fail('enabled (boolean) is required', 'action.invalidParams', undefined, { param: 'enabled', expected: 'boolean' });
  return { value: enabled ? 'on' : 'off', message: `${label} ${enabled ? 'on' : 'off'}` };
}

function settingIo(t: SettingTarget, action: DeviceActionId, params: Record<string, unknown>): SettingIo | DeviceActionResult {
  const shell = (cmd: string) => t.adb.shell(t.serial, cmd);
  const api = t.apiLevel;
  switch (action) {
    case 'appearance':
      return {
        label: 'Dark mode',
        read: async () => {
          const r = await shell('cmd uimode night');
          return r.ok ? parseNightMode(textOf(r)) : undefined;
        },
        write: async (value) => {
          const r = await shell(`cmd uimode night ${value}`);
          return !r.ok || /Error|Unknown command/i.test(r.stderr) ? fail(`Could not switch appearance: ${failureText(r)}`) : undefined;
        },
        wanted: () => {
          const mode = str(params, 'mode');
          if (mode !== 'dark' && mode !== 'light') return fail('mode must be "dark" or "light"', 'action.invalidParams', undefined, { param: 'mode', expected: 'oneOf', options: 'dark, light' });
          return { value: mode === 'dark' ? 'yes' : 'no', message: mode === 'dark' ? 'Dark mode on' : 'Light mode on' };
        },
      };
    case 'font-scale':
      return {
        label: 'Font scale',
        read: async () => {
          const r = await shell('settings get system font_scale');
          return r.ok ? settingValue(r.stdout.split('\n')[0]) : undefined;
        },
        write: async (value) => {
          const r = await shell(putSetting('system', 'font_scale', value));
          return r.ok ? undefined : fail(`Could not set the font scale: ${failureText(r)}`);
        },
        wanted: () => {
          const scale = num(params, 'scale');
          if (scale === undefined || scale < 0.5 || scale > 2.0) return fail('scale must be a number between 0.5 and 2.0', 'action.invalidParams', undefined, { param: 'scale', expected: 'range', min: 0.5, max: 2 });
          const value = String(Math.round(scale * 100) / 100);
          return { value, message: `Font scale set to ${value}` };
        },
      };
    case 'animations':
      return {
        label: 'Animation scales',
        read: async () => {
          const r = await shell(ANIMATION_KEYS.map((k) => `settings get global ${k}`).join('; '));
          if (!r.ok) return undefined;
          const values = r.stdout.split('\n').filter((l) => l.trim()).map(settingValue);
          return values.length === 3 && values.every((v): v is string => v !== undefined) ? joinScales(values) : undefined;
        },
        write: async (value) => {
          const parts = value.split(',');
          const r = await shell(ANIMATION_KEYS.map((k, i) => putSetting('global', k, parts[parts.length === 3 ? i : 0]!)).join('; '));
          return r.ok ? undefined : fail(`Could not change animation scales: ${failureText(r)}`);
        },
        wanted: () => {
          const enabled = bool(params, 'enabled');
          if (enabled === undefined) return fail('enabled (boolean) is required', 'action.invalidParams', undefined, { param: 'enabled', expected: 'boolean' });
          return { value: enabled ? '1' : '0', message: enabled ? 'Animations enabled' : 'Animations disabled' };
        },
      };
    case 'airplane-mode':
      return {
        label: 'Airplane mode',
        read: async () => {
          const r = await shell('cmd connectivity airplane-mode');
          return r.ok ? parseAirplaneMode(r.stdout) : undefined;
        },
        write: async (value) => {
          const r = await shell(`cmd connectivity airplane-mode ${value === 'on' ? 'enable' : 'disable'}`);
          return !r.ok || /Error|Exception|Unknown/i.test(textOf(r)) ? fail(`Could not change airplane mode: ${failureText(r)}`) : undefined;
        },
        wanted: () => onOff(params, 'Airplane mode'),
      };
    case 'wifi':
      return {
        label: 'Wi-Fi',
        read: async () => {
          const r = await shell('settings get global wifi_on');
          return r.ok ? parseWifiOn(r.stdout) : undefined;
        },
        write: async (value) => {
          // `cmd wifi` from Android 11; `svc wifi` before (it stopped working for the shell on newer versions).
          const cmd =
            api === undefined || api >= 30
              ? `cmd wifi set-wifi-enabled ${value === 'on' ? 'enabled' : 'disabled'}`
              : `svc wifi ${value === 'on' ? 'enable' : 'disable'}`;
          const r = await shell(cmd);
          return !r.ok || /Error|Exception|Unknown|not allowed/i.test(textOf(r)) ? fail(`Could not switch Wi-Fi: ${failureText(r)}`) : undefined;
        },
        wanted: () => onOff(params, 'Wi-Fi'),
      };
    case 'mobile-data':
      return {
        label: 'Mobile data',
        read: async () => {
          const r = await shell('settings get global mobile_data');
          const v = r.ok ? r.stdout.trim().split('\n')[0]?.trim() : undefined;
          return v === '1' ? 'on' : v === '0' ? 'off' : undefined;
        },
        write: async (value) => {
          const r = await shell(`svc data ${value === 'on' ? 'enable' : 'disable'}`);
          return !r.ok || /Error|Exception|Unknown|not allowed/i.test(textOf(r)) ? fail(`Could not switch mobile data: ${failureText(r)}`) : undefined;
        },
        wanted: () => onOff(params, 'Mobile data'),
      };
    case 'rotation':
      return {
        label: 'Rotation',
        read: async () => {
          const r = await shell('settings get system accelerometer_rotation; settings get system user_rotation');
          return r.ok ? parseRotation(r.stdout) : undefined;
        },
        write: async (value) => {
          const index = (ROTATIONS as readonly string[]).indexOf(value);
          const cmd =
            value === 'auto'
              ? 'settings put system accelerometer_rotation 1'
              : `settings put system accelerometer_rotation 0; settings put system user_rotation ${index}`;
          if (value !== 'auto' && index < 0) return fail(`Unknown rotation "${value}"`, 'action.invalidParams', undefined, { param: 'orientation', expected: 'oneOf', options: ROTATIONS.join(', '), value });
          const r = await shell(cmd);
          return r.ok ? undefined : fail(`Could not change the rotation: ${failureText(r)}`);
        },
        wanted: () => {
          const o = str(params, 'orientation');
          if (o !== 'auto' && !(ROTATIONS as readonly string[]).includes(o ?? '')) {
            return fail('orientation must be auto, portrait, landscape, reverse-portrait or reverse-landscape', 'action.invalidParams', undefined, { param: 'orientation', expected: 'oneOf', options: ['auto', ...ROTATIONS].join(', ') });
          }
          return { value: o!, message: o === 'auto' ? 'Auto-rotate on' : `Screen turned to ${o} (apps that fix their orientation keep it)` };
        },
      };
    case 'dont-keep-activities':
      return {
        label: "Don't keep activities",
        read: async () => {
          const r = await shell('settings get global always_finish_activities');
          return r.ok ? settingValue(r.stdout.split('\n')[0]) : undefined;
        },
        write: async (value) => {
          if (value !== '0' && value !== '1' && value !== DEFAULT_VALUE) return fail(`Unexpected value "${value}"`, 'action.invalidParams', undefined, { param: 'enabled', expected: 'oneOf', options: '0, 1', value });
          const r = await shell(putSetting('global', 'always_finish_activities', value));
          return r.ok ? undefined : fail(`Could not change "Don't keep activities": ${failureText(r)}`);
        },
        wanted: () => {
          const enabled = bool(params, 'enabled');
          if (enabled === undefined) return fail('enabled (boolean) is required', 'action.invalidParams', undefined, { param: 'enabled', expected: 'boolean' });
          return {
            value: enabled ? '1' : '0',
            message: enabled ? "Don't keep activities on: every screen of an app ends when you leave it" : "Don't keep activities off",
          };
        },
      };
    case 'app-permission': {
      const appId = str(params, 'appId');
      if (!validAppId(appId)) return fail('A valid package name (appId) is required', 'action.invalidParams', undefined, { param: 'appId', expected: 'appId' });
      const permission = str(params, 'permission');
      if (!permission || permission.length > 200 || !PERMISSION_RE.test(permission)) {
        return fail('permission must be a permission name such as android.permission.CAMERA', 'action.invalidParams', undefined, { param: 'permission', expected: 'permission' });
      }
      const user = userParam(params, t.users);
      if (user === 'invalid') return fail('userId is not a user of this phone', 'action.invalidParams', undefined, { param: 'userId', expected: 'user' });
      const short = permission.replace(/^android\.permission\./, '');
      return {
        label: `${short} for ${appId}`,
        scope: { appId, key: permission },
        read: async () => {
          const r = await t.adb.shell(t.serial, `dumpsys package ${shellQuote(appId)}`, { timeoutMs: 20_000 });
          return r.ok ? parseRuntimePermission(r.stdout, permission, user) : undefined;
        },
        write: async (value) => {
          const r = await shell(`pm ${value === 'granted' ? 'grant' : 'revoke'}${userFlag(user)} ${shellQuote(appId)} ${shellQuote(permission)}`);
          return permissionFailure(r, appId, permission);
        },
        wanted: () => {
          const grant = bool(params, 'grant');
          if (grant === undefined) return fail('grant (boolean) is required', 'action.invalidParams', undefined, { param: 'grant', expected: 'boolean' });
          return {
            value: grant ? 'granted' : 'denied',
            message: grant ? `${short} granted to ${appId}` : `${short} revoked from ${appId} (Android ends the app when a permission is revoked)`,
          };
        },
      };
    }
    case 'app-locale': {
      const appId = str(params, 'appId');
      if (!validAppId(appId)) return fail('A valid package name (appId) is required', 'action.invalidParams', undefined, { param: 'appId', expected: 'appId' });
      const user = userParam(params, t.users);
      if (user === 'invalid') return fail('userId is not a user of this phone', 'action.invalidParams', undefined, { param: 'userId', expected: 'user' });
      return {
        label: `Language of ${appId}`,
        scope: { appId },
        read: async () => {
          const r = await shell(`cmd locale get-app-locales ${shellQuote(appId)}${userFlag(user)}`);
          return r.ok ? parseAppLocales(textOf(r)) : undefined;
        },
        write: async (value) => {
          if (value !== 'system' && !value.split(',').every((tag) => LOCALE_RE.test(tag))) return fail(`Unexpected locale "${value}"`, 'action.invalidParams', undefined, { param: 'locale', expected: 'locale', value });
          // Without --locales the app's list is emptied: it follows the phone's language again.
          const r = await shell(`cmd locale set-app-locales ${shellQuote(appId)}${userFlag(user)}${value === 'system' ? '' : ` --locales ${value}`}`);
          const out = textOf(r);
          if (/Unknown package|not found|NameNotFound/i.test(out)) return fail(`${appId} is not installed`, 'action.appNotFound');
          return !r.ok || /Error|Exception|Unknown/i.test(out) ? fail(`Could not set the language of ${appId}: ${failureText(r)}`) : undefined;
        },
        wanted: () => {
          const locale = str(params, 'locale');
          if (!locale || (locale !== 'system' && !LOCALE_RE.test(locale))) {
            return fail('locale must be a language tag such as tr-TR, or "system"', 'action.invalidParams', undefined, { param: 'locale', expected: 'locale' });
          }
          return {
            value: locale,
            message: locale === 'system' ? `${appId} follows the phone's language again` : `${appId} now uses ${locale}`,
          };
        },
      };
    }
    default:
      return fail(`"${action}" is not a setting`, 'action.unsupported');
  }
}

function permissionFailure(r: RunResult<string>, appId: string, permission: string): DeviceActionResult | undefined {
  const out = textOf(r);
  if (/Unknown permission/i.test(out)) return fail(`Android does not know the permission ${permission}`, 'action.permissionUnknown');
  if (/has not requested permission/i.test(out)) return fail(`${appId} does not ask for ${permission}`, 'action.permissionNotRequested');
  if (/not a changeable permission type|is not a changeable|Permission .* is managed/i.test(out)) {
    return fail(`${permission} cannot be granted or revoked from outside (it is not a runtime permission)`, 'action.permissionNotChangeable');
  }
  if (/Unknown package|Package .* not found|NameNotFoundException/i.test(out)) return fail(`${appId} is not installed`, 'action.appNotFound');
  if (!r.ok || /Exception|Error:/.test(out)) return fail(`Could not change ${permission} of ${appId}: ${out || failureText(r)}`);
  return undefined;
}

/** Two setting values mean the same ("1.0" and "1"). */
const sameValue = (a: string, b: string) => a === b || (Number.isFinite(Number(a)) && Number(a) === Number(b) && a !== DEFAULT_VALUE && b !== DEFAULT_VALUE);

/**
 * Change a setting (or `{ restore: true }`: put back the value from before Dürbün's first change). Without an
 * override store it writes as before, without reading.
 */
export async function changeSetting(t: SettingTarget, action: DeviceActionId, params: Record<string, unknown>): Promise<DeviceActionResult> {
  const io = settingIo(t, action, params);
  if (isResult(io)) return io;
  const overrides = t.overrides;
  const scope = io.scope;
  if (params.restore === true) {
    const o = overrides?.get(action, scope);
    if (!o) return done(`${io.label}: Dürbün has not changed it, nothing to restore`, 'action.nothingToRestore');
    const failed = await io.write(o.previous);
    if (failed) return failed;
    overrides!.delete(action, scope);
    return done(`${io.label} restored to ${o.previous}`, 'action.settingRestored', { previous: o.current, current: o.previous });
  }
  const want = io.wanted();
  if (isResult(want)) return want;
  const { value, message } = want;
  const kept = overrides?.get(action, scope);
  const previous = overrides && !kept ? await io.read() : undefined;
  const failed = await io.write(value);
  if (failed) return failed;
  if (overrides) {
    const before = kept?.previous ?? previous;
    if (before !== undefined && sameValue(before, value)) overrides.delete(action, scope);
    else if (before !== undefined) {
      overrides.set({
        action,
        ...(scope?.appId ? { appId: scope.appId } : {}),
        ...(scope?.key ? { key: scope.key } : {}),
        previous: before,
        current: value,
        since: kept?.since ?? Date.now(),
      });
    }
  }
  return done(message);
}
