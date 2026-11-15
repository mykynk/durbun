/**
 * The Mac app's own choices (<userData>/desktop.json), next to window-state.json: things only the app
 * asks about, never the server's settings (those live in the data folder). Every field is optional; a
 * missing or broken file means "nothing chosen yet".
 */
import { promises as fsp, readFileSync } from 'node:fs';
import path from 'node:path';

export interface DesktopPrefs {
  /** "Check for updates automatically": undefined until the user answered the one-time question. */
  autoUpdateCheck?: boolean;
  /** When the last automatic update check ran (ms since epoch). */
  lastUpdateCheck?: number;
  /** A version the user chose to skip in the automatic check (the menu item still offers it). */
  skippedVersion?: string;
  /** How many times the app has started (the update question waits for a later launch). */
  launches?: number;
  /** The "Dürbün keeps running in the menu bar" note was shown once. */
  closeNoteShown?: boolean;
  /** "Do not ask again" on the move-to-Applications question. */
  moveToApplicationsDeclined?: boolean;
  /** Help → Verbose Diagnostic Log (takes effect at the next start; DURBUN_DEBUG wins). */
  verboseLog?: boolean;
  /**
   * Ports for an app started from Finder, where environment variables are out of reach (DURBUN_PORT and
   * DURBUN_SDK_PORT still win). Written by hand or by a later Settings row.
   */
  httpPort?: number;
  sdkPort?: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isPort = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65_535;

export function parseDesktopPrefs(raw: unknown): DesktopPrefs {
  const out: DesktopPrefs = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.autoUpdateCheck === 'boolean') out.autoUpdateCheck = r.autoUpdateCheck;
  if (isNum(r.lastUpdateCheck)) out.lastUpdateCheck = r.lastUpdateCheck;
  if (typeof r.skippedVersion === 'string' && /^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(r.skippedVersion)) out.skippedVersion = r.skippedVersion;
  if (isNum(r.launches)) out.launches = Math.floor(r.launches);
  if (typeof r.closeNoteShown === 'boolean') out.closeNoteShown = r.closeNoteShown;
  if (typeof r.moveToApplicationsDeclined === 'boolean') out.moveToApplicationsDeclined = r.moveToApplicationsDeclined;
  if (typeof r.verboseLog === 'boolean') out.verboseLog = r.verboseLog;
  if (isPort(r.httpPort)) out.httpPort = r.httpPort;
  if (isPort(r.sdkPort)) out.sdkPort = r.sdkPort;
  return out;
}

export function readDesktopPrefs(file: string): DesktopPrefs {
  try {
    return parseDesktopPrefs(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

/**
 * A store that writes every change atomically (tmp + rename) and in order; write errors are ignored, the
 * in-memory value stays (a preference is a convenience, never a reason to fail).
 */
export function createPrefsStore(file: string): { get(): DesktopPrefs; update(patch: Partial<DesktopPrefs>): Promise<void> } {
  let prefs = readDesktopPrefs(file);
  let chain: Promise<void> = Promise.resolve();
  const write = async (snapshot: DesktopPrefs) => {
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
      await fsp.rename(tmp, file);
    } catch {
      /* ignore */
    }
  };
  return {
    get: () => prefs,
    update(patch) {
      prefs = parseDesktopPrefs({ ...prefs, ...patch });
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (prefs as Record<string, unknown>)[k];
      const snapshot = prefs;
      chain = chain.then(() => write(snapshot));
      return chain;
    },
  };
}

/**
 * Ports and verbosity for the embedded server: an environment variable first (a second copy, tests), then
 * desktop.json, then the default. `source` says where each port came from (for the log).
 */
export function startupOptions(
  env: Record<string, string | undefined>,
  prefs: DesktopPrefs,
  defaults: { httpPort: number; sdkPort: number },
  parsePort: (value: string | undefined, fallback: number) => number,
): { httpPort: number; sdkPort: number; verbose: boolean; source: { httpPort: 'env' | 'prefs' | 'default'; sdkPort: 'env' | 'prefs' | 'default' } } {
  const pick = (envName: string, pref: number | undefined, fallback: number) => {
    const fromEnv = parsePort(env[envName], Number.NaN);
    if (!Number.isNaN(fromEnv)) return { port: fromEnv, source: 'env' as const };
    if (pref !== undefined) return { port: pref, source: 'prefs' as const };
    return { port: fallback, source: 'default' as const };
  };
  const http = pick('DURBUN_PORT', prefs.httpPort, defaults.httpPort);
  const sdk = pick('DURBUN_SDK_PORT', prefs.sdkPort, defaults.sdkPort);
  return { httpPort: http.port, sdkPort: sdk.port, verbose: Boolean(env.DURBUN_DEBUG) || prefs.verboseLog === true, source: { httpPort: http.source, sdkPort: sdk.source } };
}

/* ───────────── the UI's Settings rows (preload: durbunDesktop.prefs) ───────────── */

/** What the UI shows. `autoUpdateCheck: null` = the user was not asked yet. */
export interface PrefsView {
  autoUpdateCheck: boolean | null;
  openAtLogin: boolean;
  /** Open at Login works in the packaged app only. */
  openAtLoginAvailable: boolean;
}

export function prefsView(prefs: DesktopPrefs, login: { openAtLogin: boolean; available: boolean }): PrefsView {
  return { autoUpdateCheck: prefs.autoUpdateCheck ?? null, openAtLogin: login.available && login.openAtLogin, openAtLoginAvailable: login.available };
}

/** A change the UI asks for: only known keys with boolean values; anything else is dropped. */
export function parsePrefsPatch(raw: unknown): { autoUpdateCheck?: boolean; openAtLogin?: boolean } {
  const out: { autoUpdateCheck?: boolean; openAtLogin?: boolean } = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.autoUpdateCheck === 'boolean') out.autoUpdateCheck = r.autoUpdateCheck;
  if (typeof r.openAtLogin === 'boolean') out.openAtLogin = r.openAtLogin;
  return out;
}
