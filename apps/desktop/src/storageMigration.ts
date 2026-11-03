/**
 * One-time move of the UI's preferences to the window's new origin. Up to 0.1.x the window loaded
 * http://localhost:<port>; since it loads http://127.0.0.1:<port> (ports.ts APP_HOST) the UI would
 * start without its theme, language, noise / highlight rules and panel sizes, because localStorage
 * belongs to an origin. Once per port the app reads the old origin's `durbun.*` keys and copies those
 * the new origin lacks. Both origins are opened as data: documents with a base URL in a hidden window
 * (main.ts), so no request reaches any server: a program on [::1]:<port> cannot take part.
 * The page zoom (View → Zoom In / Out) is kept by Chromium per host, not per origin, so it moves once
 * for all ports: read from the profile's Preferences file, applied when the window first shows the UI on
 * 127.0.0.1 (main.ts), and recorded in the same file as the ports.
 * No Electron import here, so the decisions are unit-tested.
 */
import { promises as fsp, readFileSync } from 'node:fs';
import path from 'node:path';

/** The host the window used before 127.0.0.1; only read from, never loaded over the network. */
export function legacyOriginFor(port: number): string {
  return `http://localhost:${port}`;
}

/** The UI prefixes all of its keys (packages/ui/src/lib/persist.ts, data/stores/prefs.ts). */
export const UI_KEY_PREFIX = 'durbun.';
/** localStorage holds about 5 MB per origin; anything bigger than that is not the UI's. */
const MAX_COPY_CHARS = 5 * 1024 * 1024;

/** The keys to write into the new origin: the UI's own, and only those it does not have yet. */
export function entriesToCopy(from: unknown, to: unknown): Record<string, string> {
  const target = to && typeof to === 'object' ? (to as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  if (!from || typeof from !== 'object') return out;
  let total = 0;
  for (const [key, value] of Object.entries(from as Record<string, unknown>)) {
    if (!key.startsWith(UI_KEY_PREFIX) || typeof value !== 'string' || typeof target[key] === 'string') continue;
    total += key.length + value.length;
    if (total > MAX_COPY_CHARS) break;
    out[key] = value;
  }
  return out;
}

/** Empty page for the hidden window; `baseURLForDataURL` gives it the origin to read or write. */
export const BLANK_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><meta charset="utf-8"><title>Dürbün</title>')}`;

/** Page script: the UI's keys in this origin's localStorage. */
export const READ_UI_STORAGE = `(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(${JSON.stringify(UI_KEY_PREFIX)})) out[key] = localStorage.getItem(key);
  }
  return out;
})()`;

/** Page script: set the keys this origin does not have yet; resolves with how many were written. */
export function writeUiStorageScript(entries: Record<string, string>): string {
  return `((entries) => {
  let written = 0;
  for (const [key, value] of Object.entries(entries)) {
    if (localStorage.getItem(key) === null) {
      localStorage.setItem(key, value);
      written++;
    }
  }
  return written;
})(${JSON.stringify(entries)})`;
}

/** What userData/storage-migration.json records: the ports whose localStorage moved, and whether the zoom did. */
interface MigrationRecord {
  ports: number[];
  zoomMoved: boolean;
}

function readRecord(file: string): MigrationRecord {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { ports?: unknown; zoomMoved?: unknown };
    const ports = Array.isArray(raw.ports) ? raw.ports.filter((p): p is number => Number.isInteger(p) && p > 0 && p <= 65_535) : [];
    return { ports, zoomMoved: raw.zoomMoved === true };
  } catch {
    return { ports: [], zoomMoved: false };
  }
}

/** One write at a time, each on the record as it is then (the ports and the zoom are recorded at different moments). */
let writes: Promise<unknown> = Promise.resolve();

function updateRecord(file: string, change: (r: MigrationRecord) => MigrationRecord): Promise<void> {
  const next = writes.then(async () => {
    const r = change(readRecord(file));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const body = { version: 1, ports: [...new Set(r.ports)].sort((a, b) => a - b), ...(r.zoomMoved ? { zoomMoved: true } : {}) };
    await fsp.writeFile(tmp, JSON.stringify(body) + '\n', 'utf8');
    await fsp.rename(tmp, file);
  });
  writes = next.catch(() => undefined);
  return next;
}

/** Ports whose preferences were already moved (userData/storage-migration.json). */
export function readMigratedPorts(file: string): number[] {
  return readRecord(file).ports;
}

export function writeMigratedPorts(file: string, ports: readonly number[]): Promise<void> {
  return updateRecord(file, (r) => ({ ...r, ports: [...ports] }));
}

/** What main.ts does with a hidden window; injectable so the order and the outcome are tested. */
export interface StoragePage {
  /** Show an empty document of `origin` (no network). */
  open(origin: string): Promise<void>;
  run<T>(script: string): Promise<T>;
}

export type MigrationResult = { kind: 'skipped' } | { kind: 'moved'; keys: number };

/**
 * Moves the preferences of `port` once: read the old origin, read the new one, copy what is missing,
 * then record the port. A failure leaves the port unrecorded, so the next start tries again.
 */
export async function migrateUiStorage(port: number, file: string, page: () => Promise<StoragePage & { close(): void }>, newOrigin: string): Promise<MigrationResult> {
  const done = readMigratedPorts(file);
  if (done.includes(port)) return { kind: 'skipped' };
  const p = await page();
  try {
    await p.open(legacyOriginFor(port));
    const old = await p.run<unknown>(READ_UI_STORAGE);
    await p.open(newOrigin);
    const current = await p.run<unknown>(READ_UI_STORAGE);
    const copy = entriesToCopy(old, current);
    const keys = Object.keys(copy).length > 0 ? Number(await p.run<number>(writeUiStorageScript(copy))) || 0 : 0;
    await writeMigratedPorts(file, [...done, port]);
    return { kind: 'moved', keys };
  } finally {
    p.close();
  }
}

/* ───────────── page zoom ───────────── */

/** The host whose zoom level 0.1.x left behind. */
export const LEGACY_HOST = 'localhost';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A stored zoom level: a number (Electron), or { zoom_level } (Chrome's format); 0 is 100 % and never stored. */
function zoomLevelOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : isObject(v) && typeof v.zoom_level === 'number' ? v.zoom_level : undefined;
  // Chromium's zoom range is 25 %–500 %: levels about −7.6 to 8.8.
  return n !== undefined && Number.isFinite(n) && n !== 0 && Math.abs(n) <= 9 ? n : undefined;
}

/**
 * The localhost zoom level `host` should get, from the profile's Preferences
 * (partition.per_host_zoom_levels.<partition hash>.<host> = level). Undefined when localhost has none,
 * or when `host` already has its own level in any partition.
 */
export function zoomLevelToMove(prefs: unknown, host: string): number | undefined {
  const partition = isObject(prefs) ? prefs.partition : undefined;
  const byPartition = isObject(partition) ? partition.per_host_zoom_levels : undefined;
  if (!isObject(byPartition)) return undefined;
  let level: number | undefined;
  for (const hosts of Object.values(byPartition)) {
    if (!isObject(hosts)) continue;
    if (Object.hasOwn(hosts, host)) return undefined;
    level ??= zoomLevelOf(hosts[LEGACY_HOST]);
  }
  return level;
}

export type ZoomPlan = { kind: 'done' } | { kind: 'none' } | { kind: 'move'; level: number };

/**
 * Whether the zoom still has to move: 'done' (recorded earlier), 'none' (nothing to move: record it),
 * 'move' (apply `level` once the window shows the UI on `host`, then record it). Recording is what makes it
 * once: going back to 100 % on the new host removes its entry, and the old localhost level stays in the file.
 */
export function planZoomMove(file: string, prefsFile: string, host: string): ZoomPlan {
  if (readRecord(file).zoomMoved) return { kind: 'done' };
  let prefs: unknown;
  try {
    prefs = JSON.parse(readFileSync(prefsFile, 'utf8'));
  } catch {
    return { kind: 'none' }; // a new profile has no Preferences yet
  }
  const level = zoomLevelToMove(prefs, host);
  return level === undefined ? { kind: 'none' } : { kind: 'move', level };
}

export function recordZoomMoved(file: string): Promise<void> {
  return updateRecord(file, (r) => ({ ...r, zoomMoved: true }));
}

/** Apply the moved level unless the page has a zoom of its own by now; true when it was applied. */
export function applyZoomLevel(page: { getZoomLevel(): number; setZoomLevel(level: number): void }, level: number): boolean {
  if (page.getZoomLevel() !== 0) return false;
  page.setZoomLevel(level);
  return true;
}
