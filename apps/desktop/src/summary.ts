/**
 * The menu-bar line "N devices · M apps" (no Electron import, so it is unit-tested). The main process asks
 * the server it shows (GET /api/summary on 127.0.0.1) while the tray menu opens and on a calm interval. A
 * Dürbün without that endpoint (an attached older server) answers 404: the line is then left out and the
 * app stops asking until the server changes.
 */

export interface Summary {
  devices: number;
  apps: number;
}

export const SUMMARY_INTERVAL_MS = 30_000;

const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1_000_000 ? v : undefined);

/** A summary, 'unsupported' (404: stop asking), or undefined (no answer this time: show nothing). */
export function parseSummary(status: number, body: unknown): Summary | 'unsupported' | undefined {
  if (status === 404) return 'unsupported';
  if (status < 200 || status >= 300 || !body || typeof body !== 'object') return undefined;
  const r = body as Record<string, unknown>;
  const devices = count(r.devices);
  const apps = count(r.apps);
  return devices === undefined || apps === undefined ? undefined : { devices, apps };
}

export function sameSummary(a: Summary | undefined, b: Summary | undefined): boolean {
  return a === b || (!!a && !!b && a.devices === b.devices && a.apps === b.apps);
}
