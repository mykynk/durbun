/**
 * Process metric polling (`metrics.watch`), reference-counted in the UI.
 *
 * The server keeps one watch per (device, pid) and UI connection — a single `enabled: false` from this
 * connection stops it — so every caller goes through `acquireWatch`, which sends `enabled: true` on the
 * first acquire and `enabled: false` on the last release. After a reconnect the server has forgotten our
 * watches (they belong to the closed connection), so active ones are re-sent on every resync.
 */
import { onResync, sendCommand } from '../../data';

export interface WatchSpec {
  deviceId: string;
  pid: number;
}

type ErrorListener = (err: unknown) => void;

interface Entry {
  spec: WatchSpec;
  count: number;
  listeners: Set<ErrorListener>;
}

const entries = new Map<string, Entry>();
let resyncHooked = false;

export function watchKey(spec: WatchSpec): string {
  return `${spec.deviceId}|${spec.pid}`;
}

function send(spec: WatchSpec, enabled: boolean): Promise<unknown> {
  return sendCommand({ name: 'metrics.watch', deviceId: spec.deviceId, pid: spec.pid, enabled });
}

function start(key: string, entry: Entry): void {
  send(entry.spec, true).catch((err: unknown) => {
    if (entries.get(key) !== entry) return;
    for (const l of [...entry.listeners]) l(err);
  });
}

function hookResync(): void {
  if (resyncHooked) return;
  resyncHooked = true;
  onResync(() => {
    for (const [key, entry] of entries) start(key, entry);
  });
}

/**
 * Start polling a process (or join an existing poll). Returns `release`; `onError` is called when the
 * server refuses (e.g. `metrics.unsupported`) — the caller should then release.
 */
export function acquireWatch(spec: WatchSpec, onError: ErrorListener): () => void {
  hookResync();
  const key = watchKey(spec);
  let entry = entries.get(key);
  if (!entry) {
    entry = { spec, count: 0, listeners: new Set() };
    entries.set(key, entry);
  }
  entry.count++;
  entry.listeners.add(onError);
  if (entry.count === 1) start(key, entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const cur = entries.get(key);
    if (!cur) return;
    cur.listeners.delete(onError);
    cur.count--;
    if (cur.count <= 0) {
      entries.delete(key);
      send(cur.spec, false).catch(() => {
        /* the watch dies with the connection anyway */
      });
    }
  };
}

/** Keys currently polled by this UI (for indicators). */
export function activeWatchKeys(): string[] {
  return [...entries.keys()];
}
