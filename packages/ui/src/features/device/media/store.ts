/**
 * The media library as this window sees it: screenshots and screen recordings the server keeps on disk
 * (GET /api/media, `MediaItem`), the viewer that opens one of them, and deferred deletes with an undo.
 *
 * Kept light on purpose: the Logs tab imports it for the "a screenshot was taken here" markers, so it pulls in no
 * Device tab code. The viewer itself is lazy (`ViewerHost`).
 */
import { create } from 'zustand';
import type { LogEntry, MediaItem, MediaKind, MediaList, MediaPolicy, MediaRef } from '@durbun/protocol';
import { toast } from '../../../components';
import { ApiError, onResync, onServerMessage } from '../../../data';
import { errorText, t } from '../../../i18n';
import './i18n';

/** An item of this window only: the server kept no copy (an older server). Delete only drops it here. */
export type GalleryItem = MediaItem & { local?: true };

export type MediaStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface MediaLibraryState {
  status: MediaStatus;
  /** The caught load error (worded at render time). */
  error?: unknown;
  /** Every device, newest first. */
  items: GalleryItem[];
  policy?: MediaPolicy;
  usedBytes: number;
  total: number;
  /** Items hidden while their delete waits for the undo window. */
  pendingDelete: Record<string, true>;
}

export const useMediaLibrary = create<MediaLibraryState>()(() => ({ status: 'idle', items: [], usedBytes: 0, total: 0, pendingDelete: {} }));

/** Delete waits this long so "Undo" can take it back (nothing is removed on the server before). */
export const DELETE_UNDO_MS = 6_000;

const MEDIA_CODES = new Set(['media.screenshot', 'media.recording']);

/* ───────────── REST ───────────── */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : 'Network error', 'network');
  }
  if (!res.ok) {
    let body: Record<string, unknown> | undefined;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = undefined;
    }
    throw new ApiError(res.status, typeof body?.error === 'string' ? body.error : `${res.status}`, typeof body?.code === 'string' ? body.code : undefined, body);
  }
  return (await res.json()) as T;
}

/** `?download=1` URL of an item (server items only). */
export function mediaDownloadUrl(item: GalleryItem): string {
  return item.local ? item.url : `${item.url}${item.url.includes('?') ? '&' : '?'}download=1`;
}

/** Whether a reply / list looks like what this UI understands (a newer or older server). */
export function isMediaItem(v: unknown): v is MediaItem {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    (m.kind === 'screenshot' || m.kind === 'recording') &&
    typeof m.deviceId === 'string' &&
    typeof m.ts === 'number' &&
    typeof m.url === 'string' &&
    m.url.startsWith('/') &&
    typeof m.fileName === 'string'
  );
}

export function parseMediaList(v: unknown): Pick<MediaLibraryState, 'items' | 'policy' | 'usedBytes' | 'total'> {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<MediaList>;
  const items = Array.isArray(o.items) ? o.items.filter(isMediaItem) : [];
  const p = o.policy;
  const policy =
    p && typeof p.maxAgeDays === 'number' && typeof p.maxBytes === 'number' && typeof p.maxItems === 'number' ? { maxAgeDays: p.maxAgeDays, maxBytes: p.maxBytes, maxItems: p.maxItems } : undefined;
  return { items, policy, usedBytes: typeof o.usedBytes === 'number' ? o.usedBytes : 0, total: typeof o.total === 'number' ? o.total : items.length };
}

/* ───────────── loading ───────────── */

let inflight: Promise<void> | undefined;

/** Load (or refresh) the list. The first load shows "loading"; later ones keep the list on screen. */
export function loadMedia(): Promise<void> {
  if (inflight) return inflight;
  startSync();
  const s = useMediaLibrary.getState();
  if (s.status !== 'ready') useMediaLibrary.setState({ status: 'loading', error: undefined });
  inflight = request<MediaList>('/api/media')
    .then((list) => {
      const parsed = parseMediaList(list);
      // Items only this window holds (an older server) stay.
      const locals = useMediaLibrary.getState().items.filter((i) => i.local);
      useMediaLibrary.setState({ status: 'ready', error: undefined, ...parsed, items: mergeNewestFirst(parsed.items, locals) });
    })
    .catch((err: unknown) => {
      // A list already on screen stays; the error shows only when there is nothing to show.
      if (useMediaLibrary.getState().status !== 'ready') useMediaLibrary.setState({ status: 'error', error: err });
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

/** Load once when nothing was loaded yet (cards and the viewer call this on mount). */
export function ensureMedia(): void {
  const s = useMediaLibrary.getState().status;
  if (s === 'idle' || s === 'error') void loadMedia();
}

function mergeNewestFirst(a: GalleryItem[], b: GalleryItem[]): GalleryItem[] {
  if (!b.length) return a;
  const ids = new Set(a.map((i) => i.id));
  return [...a, ...b.filter((i) => !ids.has(i.id))].sort((x, y) => y.ts - x.ts);
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function refreshSoon(): void {
  if (useMediaLibrary.getState().status === 'idle') return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void loadMedia(), 400);
}

let syncing = false;
/** Another window took a screenshot (its marker line arrives here) or the connection came back: refresh. */
function startSync(): void {
  if (syncing) return;
  syncing = true;
  onServerMessage((msg) => {
    if (msg.type !== 'batch' || !msg.logs) return;
    for (const e of msg.logs) {
      if (e.code && MEDIA_CODES.has(e.code)) {
        const ref = mediaRefOf(e);
        if (!ref || !useMediaLibrary.getState().items.some((i) => i.id === ref.id)) refreshSoon();
        return;
      }
    }
  });
  onResync(() => refreshSoon());
}

/* ───────────── changes from this window ───────────── */

let localSeq = 0;

/** A reply of `screenshot` / `screen-record(-stop)`: its library item, or a window-only one from `url`. */
export function addFromReply(deviceId: string, kind: MediaKind, data: unknown, extra: { ts?: number; durationSec?: number } = {}): GalleryItem | null {
  const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  if (!d) return null;
  if (isMediaItem(d.media)) {
    const item = d.media;
    useMediaLibrary.setState((s) => {
      if (s.items.some((i) => i.id === item.id)) return s;
      return { items: mergeNewestFirst([item], s.items), total: s.total + 1, usedBytes: s.usedBytes + (item.bytes || 0) };
    });
    return useMediaLibrary.getState().items.find((i) => i.id === item.id) ?? item;
  }
  if (typeof d.url !== 'string' || !d.url) return null;
  const known = useMediaLibrary.getState().items.find((i) => i.url === d.url);
  if (known) return known;
  const ts = extra.ts ?? Date.now();
  const item: GalleryItem = {
    id: `local-${++localSeq}`,
    local: true,
    kind,
    deviceId,
    ts,
    url: d.url,
    bytes: 0,
    fileName: typeof d.file === 'string' ? d.file.split(/[\\/]/).pop() || `${kind}` : `${kind}`,
  };
  if (typeof d.width === 'number' && typeof d.height === 'number') {
    item.width = d.width;
    item.height = d.height;
  }
  if (extra.durationSec) item.durationSec = extra.durationSec;
  useMediaLibrary.setState((s) => ({ items: mergeNewestFirst([item], s.items) }));
  return item;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function setPending(ids: readonly string[], on: boolean): void {
  useMediaLibrary.setState((s) => {
    const pendingDelete = { ...s.pendingDelete };
    for (const id of ids) {
      if (on) pendingDelete[id] = true;
      else delete pendingDelete[id];
    }
    return { pendingDelete };
  });
}

function dropLocally(ids: readonly string[]): void {
  const set = new Set(ids);
  useMediaLibrary.setState((s) => {
    const gone = s.items.filter((i) => set.has(i.id) && !i.local);
    const pendingDelete = { ...s.pendingDelete };
    for (const id of ids) delete pendingDelete[id];
    return {
      items: s.items.filter((i) => !set.has(i.id)),
      total: Math.max(0, s.total - gone.length),
      usedBytes: Math.max(0, s.usedBytes - gone.reduce((n, i) => n + (i.bytes || 0), 0)),
      pendingDelete,
    };
  });
}

/**
 * Delete items: hidden at once, removed on the server after DELETE_UNDO_MS unless "Undo" is pressed. A device's
 * whole set (`deviceId`) goes in one request.
 */
export function deleteMedia(ids: readonly string[], opts: { deviceId?: string } = {}): void {
  const list = ids.filter((id) => !useMediaLibrary.getState().pendingDelete[id]);
  if (!list.length) return;
  const items = useMediaLibrary.getState().items.filter((i) => list.includes(i.id));
  setPending(list, true);
  closeViewerIfAmong(list);
  const key = list.join(',');
  const commit = async () => {
    timers.delete(key);
    const server = items.filter((i) => !i.local).map((i) => i.id);
    try {
      if (opts.deviceId && server.length > 1) await request(`/api/media?deviceId=${encodeURIComponent(opts.deviceId)}`, { method: 'DELETE' });
      else for (const id of server) await request(`/api/media/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch((err) => {
        // Already gone (another window, the limits): the goal is reached.
        if (!(err instanceof ApiError && err.code === 'media.unknown')) throw err;
      });
      dropLocally(list);
    } catch (err) {
      setPending(list, false);
      toast.error(t('media.deleteFailed'), { description: errorText(err) });
    }
  };
  timers.set(key, setTimeout(() => void commit(), DELETE_UNDO_MS));
  const one = items.length === 1 ? items[0] : undefined;
  toast.info(one ? t(one.kind === 'screenshot' ? 'media.deletedShot' : 'media.deletedRecording') : t('media.deletedMany', { count: items.length }), {
    id: `media-delete-${key}`,
    duration: DELETE_UNDO_MS,
    action: {
      label: t('media.undo'),
      onClick: () => {
        const timer = timers.get(key);
        if (!timer) return;
        clearTimeout(timer);
        timers.delete(key);
        setPending(list, false);
      },
    },
  });
}

/** Deletes still waiting for their undo window go now (the page is being left). */
export function flushPendingDeletes(): void {
  for (const [key, timer] of timers) {
    clearTimeout(timer);
    timers.delete(key);
    for (const id of key.split(',')) {
      const item = useMediaLibrary.getState().items.find((i) => i.id === id);
      if (item && !item.local) void fetch(`/api/media/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(() => undefined);
    }
  }
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushPendingDeletes);

/* ───────────── viewer ───────────── */

export interface ViewerState {
  /** Item shown, or a marker's item that is no longer in the library. */
  open: { id: string; missing?: MediaRef & { ts?: number; deviceId?: string } } | null;
}

export const useMediaViewer = create<ViewerState>()(() => ({ open: null }));

export function openMedia(id: string): void {
  useMediaViewer.setState({ open: { id } });
}

export function closeMedia(): void {
  useMediaViewer.setState({ open: null });
}

function closeViewerIfAmong(ids: readonly string[]): void {
  const open = useMediaViewer.getState().open;
  if (!open || !ids.includes(open.id)) return;
  // Step to a neighbour of the same device so a run of deletes keeps going; none left: close.
  const list = visibleItems().filter((i) => i.deviceId === itemDevice(open.id));
  const at = list.findIndex((i) => i.id === open.id);
  const next = list.slice(at + 1).find((i) => !ids.includes(i.id)) ?? list.slice(0, Math.max(0, at)).reverse().find((i) => !ids.includes(i.id));
  useMediaViewer.setState({ open: next ? { id: next.id } : null });
}

function itemDevice(id: string): string | undefined {
  return useMediaLibrary.getState().items.find((i) => i.id === id)?.deviceId;
}

/** Items not waiting for a delete. */
export function visibleItems(s: MediaLibraryState = useMediaLibrary.getState()): GalleryItem[] {
  const pending = s.pendingDelete;
  return Object.keys(pending).length ? s.items.filter((i) => !pending[i.id]) : s.items;
}

/** `data.media` of a log marker line, or undefined. */
export function mediaRefOf(e: Pick<LogEntry, 'code' | 'data'>): MediaRef | undefined {
  if (!e.code || !MEDIA_CODES.has(e.code)) return undefined;
  const m = (e.data as { media?: unknown } | null | undefined)?.media as Partial<MediaRef> | undefined;
  if (!m || typeof m.id !== 'string' || (m.kind !== 'screenshot' && m.kind !== 'recording')) return undefined;
  return { id: m.id, kind: m.kind };
}

/** Open the item a log marker points at; a deleted one opens the viewer's "no longer there" state. */
export async function openMediaRef(ref: MediaRef, at?: { ts?: number; deviceId?: string }): Promise<void> {
  const has = () => visibleItems().some((i) => i.id === ref.id);
  if (!has()) await loadMedia();
  if (has()) openMedia(ref.id);
  else useMediaViewer.setState({ open: { id: ref.id, missing: { ...ref, ...at } } });
}
