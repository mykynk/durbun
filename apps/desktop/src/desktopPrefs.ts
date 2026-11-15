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
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

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
