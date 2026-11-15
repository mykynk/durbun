/**
 * The Mac app's server settings (HTTP and SDK ports, verbose log) and its restart, through the bridge
 * (`window.durbunDesktop.config` / `relaunch`). A change made in the app's menus or another window arrives as
 * the 'config-changed' command and is read again. Without the bridge (a browser, the CLI, an older app)
 * `available` is false and Settings hides the rows.
 */
import { useCallback, useEffect, useState } from 'react';

export type ConfigSource = 'env' | 'file' | 'default';

export interface ConfigField<T> {
  /** What the next start uses. */
  value: T;
  source: ConfigSource;
  /** The value saved in the app (null: none saved). */
  saved: T | null;
  default: T;
  /** The environment variable that wins over the saved value; with source 'env' the row cannot change it. */
  env: string;
  /** This run started with another value: it applies after a restart. */
  pending: boolean;
}

export interface ConfigView {
  httpPort: ConfigField<number>;
  sdkPort: ConfigField<number>;
  verboseLog: ConfigField<boolean>;
  restartNeeded: boolean;
  listening: { httpPort: number | null; sdkPort: number | null };
}

export type ConfigKey = 'httpPort' | 'sdkPort' | 'verboseLog';
export type ConfigError = 'invalidPort' | 'samePorts' | 'invalidValue';
/** null puts the field back to its default. */
export interface ConfigPatch {
  httpPort?: number | null;
  sdkPort?: number | null;
  verboseLog?: boolean | null;
}
export type ConfigResult = { ok: true; config: ConfigView } | { ok: false; error: ConfigError; field: ConfigKey; config?: ConfigView } | { ok: false; error: 'bridge' };

/** Ports the app accepts (appConfig.ts isUserPort). */
export const MIN_USER_PORT = 1024;
export const MAX_PORT = 65_535;

export function isUserPort(v: number): boolean {
  return Number.isInteger(v) && v >= MIN_USER_PORT && v <= MAX_PORT;
}

interface ConfigBridge {
  get(): Promise<unknown>;
  set(patch: ConfigPatch): Promise<unknown>;
}

function desktop(): { config?: Partial<ConfigBridge>; relaunch?: () => Promise<boolean> } | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { durbunDesktop?: { config?: Partial<ConfigBridge>; relaunch?: () => Promise<boolean> } }).durbunDesktop;
}

function bridge(): ConfigBridge | undefined {
  const c = desktop()?.config;
  return c && typeof c.get === 'function' && typeof c.set === 'function' ? (c as ConfigBridge) : undefined;
}

const SOURCES = new Set<ConfigSource>(['env', 'file', 'default']);

function field<T>(v: unknown, isT: (x: unknown) => x is T): ConfigField<T> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (!isT(o.value) || !isT(o.default) || !SOURCES.has(o.source as ConfigSource)) return undefined;
  return {
    value: o.value,
    source: o.source as ConfigSource,
    saved: isT(o.saved) ? o.saved : null,
    default: o.default,
    env: typeof o.env === 'string' ? o.env : '',
    pending: o.pending === true,
  };
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isBool = (x: unknown): x is boolean => typeof x === 'boolean';
const portOrNull = (x: unknown): number | null => (isNum(x) ? x : null);

/** The bridge's ConfigView, or undefined when it is not the expected shape. */
export function parseConfigView(v: unknown): ConfigView | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const httpPort = field(o.httpPort, isNum);
  const sdkPort = field(o.sdkPort, isNum);
  const verboseLog = field(o.verboseLog, isBool);
  if (!httpPort || !sdkPort || !verboseLog) return undefined;
  const l = (o.listening && typeof o.listening === 'object' ? o.listening : {}) as Record<string, unknown>;
  return {
    httpPort,
    sdkPort,
    verboseLog,
    restartNeeded: o.restartNeeded === true || httpPort.pending || sdkPort.pending || verboseLog.pending,
    listening: { httpPort: portOrNull(l.httpPort), sdkPort: portOrNull(l.sdkPort) },
  };
}

/** The reply of `config.set`. */
export function parseConfigResult(v: unknown): ConfigResult {
  if (!v || typeof v !== 'object') return { ok: false, error: 'bridge' };
  const o = v as Record<string, unknown>;
  const config = parseConfigView(o.config);
  if (o.ok === true && config) return { ok: true, config };
  if (o.ok === false && (o.error === 'invalidPort' || o.error === 'samePorts' || o.error === 'invalidValue')) {
    const f = o.field === 'httpPort' || o.field === 'sdkPort' || o.field === 'verboseLog' ? o.field : 'httpPort';
    return { ok: false, error: o.error, field: f, ...(config ? { config } : {}) };
  }
  return { ok: false, error: 'bridge' };
}

export function hasDesktopConfig(): boolean {
  return !!bridge();
}

export function canRelaunch(): boolean {
  return typeof desktop()?.relaunch === 'function';
}

/** Restarts the app; false when it cannot now (or there is no bridge). */
export async function relaunchDesktop(): Promise<boolean> {
  const r = desktop()?.relaunch;
  if (typeof r !== 'function') return false;
  try {
    return (await r()) === true;
  } catch {
    return false;
  }
}

export function useDesktopConfig(): { available: boolean; config: ConfigView | undefined; saving: boolean; set(patch: ConfigPatch): Promise<ConfigResult> } {
  const available = hasDesktopConfig();
  const [config, setConfig] = useState<ConfigView | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const b = bridge();
    if (!b) return;
    let alive = true;
    const load = () =>
      void b
        .get()
        .then((v) => {
          const c = parseConfigView(v);
          if (alive && c) setConfig(c);
        })
        .catch(() => undefined);
    load();
    const onCommand = (e: Event) => {
      if ((e as CustomEvent<unknown>).detail === 'config-changed') load();
    };
    window.addEventListener('durbun:command', onCommand);
    return () => {
      alive = false;
      window.removeEventListener('durbun:command', onCommand);
    };
  }, []);

  const set = useCallback(async (patch: ConfigPatch): Promise<ConfigResult> => {
    const b = bridge();
    if (!b) return { ok: false, error: 'bridge' };
    setSaving(true);
    try {
      const r = parseConfigResult(await b.set(patch));
      if (r.ok) setConfig(r.config);
      else if ('config' in r && r.config) setConfig(r.config);
      return r;
    } catch {
      return { ok: false, error: 'bridge' };
    } finally {
      setSaving(false);
    }
  }, []);

  return { available, config, saving, set };
}
