/**
 * Which data this window shows: the live data (undefined) or an opened session recording (its id, SPEC §13.3).
 * The socket connects `WS /ui?view=<id>` and the REST helpers that read the shown data (network detail, bodies,
 * search, export, HAR, bug report) add `view=<id>`; everything server-wide (settings, mocks, flows, media) stays the
 * same. `features/recordings/store.ts` switches it; this module only holds the id so `ws.ts` and `api.ts` need no
 * feature import.
 */
let viewId: string | undefined;

export function currentView(): string | undefined {
  return viewId;
}

export function setCurrentView(id: string | undefined): void {
  viewId = id || undefined;
}

/** `path` with `view=<id>` when a recording is shown (an existing query is kept). */
export function withView(path: string): string {
  if (!viewId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}view=${encodeURIComponent(viewId)}`;
}
