/**
 * Ports and verbose logging for the embedded server, as the app's own settings (no Electron import, so it
 * is unit-tested). An app started from Finder never sees environment variables, so desktop.json holds the
 * values the user picked in Settings; the priority is environment variable > desktop.json > default. A
 * change applies at the next start: the view says when the saved values differ from the ones this run
 * started with (`restartNeeded`).
 */
import type { DesktopPrefs } from './desktopPrefs';

export type ConfigSource = 'env' | 'file' | 'default';

/** Ports a user can pick: the unprivileged range (below 1024 is for system services). */
export const MIN_USER_PORT = 1024;
export const MAX_PORT = 65_535;

export const ENV_NAMES = { httpPort: 'DURBUN_PORT', sdkPort: 'DURBUN_SDK_PORT', verboseLog: 'DURBUN_DEBUG' } as const;

export const isUserPort = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= MIN_USER_PORT && v <= MAX_PORT;

/** What the next start uses, and where each value comes from. */
export interface ResolvedConfig {
  httpPort: number;
  sdkPort: number;
  verbose: boolean;
  source: { httpPort: ConfigSource; sdkPort: ConfigSource; verboseLog: ConfigSource };
}

/** A port variable: digits only, 1–65535 (a second copy or a test may use any port it likes). */
function envPort(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,5}$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return n >= 1 && n <= MAX_PORT ? n : undefined;
}

/** DURBUN_DEBUG: set and not "0" / "false" / "no" / "off" → on; set to one of those → off; unset or empty → not set. */
function envFlag(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return !/^(0|false|no|off)$/i.test(value.trim());
}

/**
 * Environment first, then desktop.json, then the defaults. A file value outside 1024–65535 is ignored, and so
 * is a file port that would land on the other port (the server could not start with both on one port).
 */
export function resolveConfig(env: Readonly<Record<string, string | undefined>>, prefs: DesktopPrefs, defaults: { httpPort: number; sdkPort: number }): ResolvedConfig {
  const pick = (variable: string | undefined, saved: number | undefined, fallback: number): { port: number; source: ConfigSource } => {
    const fromEnv = envPort(variable);
    if (fromEnv !== undefined) return { port: fromEnv, source: 'env' };
    if (isUserPort(saved)) return { port: saved, source: 'file' };
    return { port: fallback, source: 'default' };
  };
  let http = pick(env[ENV_NAMES.httpPort], prefs.httpPort, defaults.httpPort);
  let sdk = pick(env[ENV_NAMES.sdkPort], prefs.sdkPort, defaults.sdkPort);
  if (http.port === sdk.port) {
    // The file is what gives way (the environment is someone's deliberate choice): the SDK port first.
    if (sdk.source === 'file') sdk = { port: defaults.sdkPort, source: 'default' };
    else if (http.source === 'file') http = { port: defaults.httpPort, source: 'default' };
  }
  const fromEnv = envFlag(env[ENV_NAMES.verboseLog]);
  const verboseSource: ConfigSource = fromEnv !== undefined ? 'env' : prefs.verboseLog !== undefined ? 'file' : 'default';
  const verbose = fromEnv ?? prefs.verboseLog ?? false;
  return { httpPort: http.port, sdkPort: sdk.port, verbose, source: { httpPort: http.source, sdkPort: sdk.source, verboseLog: verboseSource } };
}

/* ───────────── the UI's Settings rows (preload: durbunDesktop.config) ───────────── */

export interface ConfigField<T> {
  /** What the next start uses. */
  value: T;
  source: ConfigSource;
  /** The value saved in the app's settings (null: none saved, the default or the variable applies). */
  saved: T | null;
  default: T;
  /** The environment variable that wins over the saved value (source 'env': the row cannot change it). */
  env: string;
  /** This run started with another value: it applies after a restart. */
  pending: boolean;
}

export interface ConfigView {
  httpPort: ConfigField<number>;
  sdkPort: ConfigField<number>;
  verboseLog: ConfigField<boolean>;
  /** At least one field is pending. */
  restartNeeded: boolean;
  /** The ports the server listens on right now (null: not running, or another Dürbün's ports are not known). */
  listening: { httpPort: number | null; sdkPort: number | null };
}

export function configView(
  env: Readonly<Record<string, string | undefined>>,
  prefs: DesktopPrefs,
  defaults: { httpPort: number; sdkPort: number },
  /** What this run started with (undefined before the server started: nothing is pending). */
  startedWith: { httpPort: number; sdkPort: number; verbose: boolean } | undefined,
  listening: { httpPort?: number; sdkPort?: number } = {},
): ConfigView {
  const next = resolveConfig(env, prefs, defaults);
  const pending = (a: unknown, b: unknown) => startedWith !== undefined && a !== b;
  const httpPort: ConfigField<number> = {
    value: next.httpPort,
    source: next.source.httpPort,
    saved: isUserPort(prefs.httpPort) ? prefs.httpPort : null,
    default: defaults.httpPort,
    env: ENV_NAMES.httpPort,
    pending: pending(next.httpPort, startedWith?.httpPort),
  };
  const sdkPort: ConfigField<number> = {
    value: next.sdkPort,
    source: next.source.sdkPort,
    saved: isUserPort(prefs.sdkPort) ? prefs.sdkPort : null,
    default: defaults.sdkPort,
    env: ENV_NAMES.sdkPort,
    pending: pending(next.sdkPort, startedWith?.sdkPort),
  };
  const verboseLog: ConfigField<boolean> = {
    value: next.verbose,
    source: next.source.verboseLog,
    saved: prefs.verboseLog ?? null,
    default: false,
    env: ENV_NAMES.verboseLog,
    pending: pending(next.verbose, startedWith?.verbose),
  };
  return {
    httpPort,
    sdkPort,
    verboseLog,
    restartNeeded: httpPort.pending || sdkPort.pending || verboseLog.pending,
    listening: { httpPort: listening.httpPort ?? null, sdkPort: listening.sdkPort ?? null },
  };
}

/** A change the UI asks for: a number sets, null clears (back to the default). Unknown keys are dropped. */
export interface ConfigPatch {
  httpPort?: number | null;
  sdkPort?: number | null;
  verboseLog?: boolean | null;
}

export type ConfigError = 'invalidPort' | 'samePorts' | 'invalidValue';

export type ConfigCheck = { ok: true; prefs: Pick<DesktopPrefs, 'httpPort' | 'sdkPort' | 'verboseLog'> } | { ok: false; error: ConfigError; field: keyof ConfigPatch };

/**
 * Checks a patch against the saved values and the environment: ports are integers 1024–65535 and the two
 * ports that would apply at the next start differ. Returns the desktop.json fields to write (undefined
 * removes one) or the first problem.
 */
export function checkConfigPatch(
  raw: unknown,
  env: Readonly<Record<string, string | undefined>>,
  prefs: DesktopPrefs,
  defaults: { httpPort: number; sdkPort: number },
): ConfigCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'invalidValue', field: 'httpPort' };
  const r = raw as Record<string, unknown>;
  const out: Pick<DesktopPrefs, 'httpPort' | 'sdkPort' | 'verboseLog'> = {};
  const touched = new Set<keyof ConfigPatch>();
  for (const field of ['httpPort', 'sdkPort'] as const) {
    if (!(field in r) || r[field] === undefined) continue;
    const v = r[field];
    if (v === null) out[field] = undefined;
    else if (isUserPort(v)) out[field] = v;
    else return { ok: false, error: typeof v === 'number' ? 'invalidPort' : 'invalidValue', field };
    touched.add(field);
  }
  if ('verboseLog' in r && r.verboseLog !== undefined) {
    const v = r.verboseLog;
    if (v === null) out.verboseLog = undefined;
    else if (typeof v === 'boolean') out.verboseLog = v;
    else return { ok: false, error: 'invalidValue', field: 'verboseLog' };
    touched.add('verboseLog');
  }
  // The ports the next start would use, the environment included (DURBUN_PORT=9751 + a saved SDK port 9751).
  const merged: DesktopPrefs = { ...prefs };
  for (const k of touched) {
    const v = out[k];
    if (v === undefined) delete merged[k];
    else (merged as Record<string, unknown>)[k] = v;
  }
  const httpEnv = envPort(env[ENV_NAMES.httpPort]);
  const sdkEnv = envPort(env[ENV_NAMES.sdkPort]);
  const nextHttp = httpEnv ?? (isUserPort(merged.httpPort) ? merged.httpPort : defaults.httpPort);
  const nextSdk = sdkEnv ?? (isUserPort(merged.sdkPort) ? merged.sdkPort : defaults.sdkPort);
  if ((touched.has('httpPort') || touched.has('sdkPort')) && nextHttp === nextSdk) return { ok: false, error: 'samePorts', field: touched.has('sdkPort') ? 'sdkPort' : 'httpPort' };
  return { ok: true, prefs: out };
}
