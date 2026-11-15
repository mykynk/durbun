/**
 * What a shared file (session export, HAR) may carry. Masked by default (the owner's decision): secret header
 * values, cookies, secret-looking query parameters and JSON / form fields become "••••" (protocol secrets.ts,
 * the heuristic "create a flow from requests" uses). Raw only on request (mask=0 / mask: false).
 * Masked or not, this Mac's local paths (a crash row's copy under ~/.durbun/tmp) keep their file name only.
 */
import os from 'node:os';
import path from 'node:path';
import { maskLogEntry, maskNetworkDetail, type LogEntry, type NetworkDetail, type SessionExport } from '@durbun/protocol';

/** `mask` query parameter of GET /api/export: only "0" / "false" / "no" / "off" export raw. */
export function maskParam(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

const MAX_DEPTH = 8;

/** A path that names this Mac's file system: absolute, under the home directory or one of the given roots. */
function localPath(value: string, roots: string[]): boolean {
  return value.length > 1 && path.isAbsolute(value) && roots.some((r) => value === r || value.startsWith(r.endsWith('/') ? r : `${r}/`));
}

/** Local directories whose paths are cut down to the file name (the user's home covers the data and temp dirs). */
export function localRoots(extra: string[] = []): string[] {
  const out = new Set<string>();
  try {
    const home = os.homedir();
    if (home && home !== '/') out.add(home);
  } catch {
    // no home directory: the given roots still count
  }
  for (const r of extra) if (r && path.isAbsolute(r) && r !== '/') out.add(path.resolve(r));
  try {
    const tmp = os.tmpdir();
    if (tmp && tmp !== '/') out.add(tmp);
  } catch {
    // no temp directory
  }
  return [...out];
}

function stripValue(value: unknown, roots: string[], depth: number): unknown {
  if (typeof value === 'string') return localPath(value, roots) ? path.basename(value) : value;
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const s = stripValue(v, roots, depth + 1);
      if (s !== v) changed = true;
      return s;
    });
    return changed ? out : value;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const s = stripValue(v, roots, depth + 1);
    if (s !== v) changed = true;
    out[k] = s;
  }
  return changed ? out : value;
}

/**
 * A log row without this Mac's local paths in its data: `data.file` (any absolute path) and every string under
 * the home, temp or data directories become the file name.
 */
export function stripLocalPaths(e: LogEntry, roots: string[]): LogEntry {
  if (e.data === undefined || e.data === null || typeof e.data !== 'object') return e;
  let data = stripValue(e.data, roots, 0) as Record<string, unknown>;
  const file = (data as { file?: unknown }).file;
  if (typeof file === 'string' && path.isAbsolute(file)) data = { ...data, file: path.basename(file) };
  return data === e.data ? e : { ...e, data };
}

/** The session file as it is written: local paths cut, secrets masked unless `mask` is false. */
export function cleanSessionExport(data: SessionExport, opts: { mask: boolean; roots?: string[] }): SessionExport {
  const roots = opts.roots ?? localRoots();
  const logs = data.logs.map((e) => {
    const stripped = stripLocalPaths(e, roots);
    return opts.mask ? maskLogEntry(stripped) : stripped;
  });
  const out: SessionExport = { ...data, logs, network: opts.mask ? data.network.map(maskNetworkDetail) : data.network };
  if (opts.mask) out.masked = true;
  else delete out.masked;
  return out;
}

/** Requests as a HAR file carries them: masked unless `mask` is false. */
export function cleanHarDetails(details: NetworkDetail[], opts: { mask: boolean }): NetworkDetail[] {
  return opts.mask ? details.map(maskNetworkDetail) : details;
}
