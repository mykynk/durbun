/**
 * Opened recordings (SPEC §13.3). A recording is never mixed into the live data: opening one reads it (store.ts)
 * into a hub of its own, imported like a `.durbun.json` file (read-only `import:` devices), with its own UI channel
 * and REST handler. A window shows it by connecting `WS /ui?view=<id>` and adding `view=<id>` to its network /
 * HAR / export / bug report requests; live capture goes on in the live hub meanwhile and the window comes back to it
 * by reconnecting without `view`.
 *
 * Memory: a view holds at most what the live limits hold (the newest part of the recording). A view nobody shows
 * for IDLE_MS is dropped; at most MAX_VIEWS stay loaded (the least recently used idle one goes first).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebSocket } from 'ws';
import type { ServerSettings, ServerToUi, SessionRecording, SessionRecordingOpen } from '@durbun/protocol';
import type { ApiHandler } from '../http/api';
import type { UiChannel, UiResumeRequest } from '../http/uiSocket';
import { errorMessage, HttpError, sendError } from '../http/util';
import type { Hub, Logger } from '../types';
import { readRecording, RECORDING_ID, summarize } from './store';

export const IDLE_MS = 60_000;
export const MAX_VIEWS = 2;
const MB = 1024 * 1024;

/** REST paths a `view=<id>` sends to the opened recording instead of the live data. */
export const VIEW_PATHS = /^\/api\/(?:network(?:\/.*)?|har|export|bug-report)\/?$/;

export interface View {
  readonly id: string;
  readonly hub: Hub;
  readonly channel: UiChannel;
  readonly api: ApiHandler;
  readonly opened: SessionRecordingOpen;
  lastUsed: number;
  dispose(): void;
}

export interface RecordingViewsDeps {
  /** `<dataDir>/recordings`. */
  root: string;
  settings(): ServerSettings;
  logger: Logger;
  version: string;
  /** A new hub for a view (the server's own createHub). */
  createHub(settings: ServerSettings): Hub;
  /** The view's UI channel and REST handler (http/app.ts builds them like the live ones, on `hub`). */
  wire(hub: Hub, recording: SessionRecording): { channel: UiChannel; api: ApiHandler; dispose(): void };
  /** The recording this run writes (it is live, so it never opens as a view). */
  liveId(): string | undefined;
  now?: () => number;
  idleMs?: number;
  maxViews?: number;
}

/** "2026-11-15 21:40" in the Mac's time: the label of the view's imported devices. */
function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export class RecordingViews {
  private readonly views = new Map<string, View>();
  private readonly loading = new Map<string, Promise<View>>();
  private readonly timer: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly deps: RecordingViewsDeps) {
    this.now = deps.now ?? Date.now;
    this.timer = setInterval(() => this.dropIdle(), Math.max(1_000, Math.floor((deps.idleMs ?? IDLE_MS) / 2)));
    this.timer.unref();
  }

  get size(): number {
    return this.views.size;
  }

  /** POST /api/recordings/:id/open. Throws HttpError (404 recorder.unknown, 409 recorder.live, 422 recorder.unreadable). */
  async open(id: string): Promise<SessionRecordingOpen> {
    const view = await this.load(id);
    view.lastUsed = this.now();
    return view.opened;
  }

  /** The loaded view, loading it when the recording exists; undefined when it does not (or is the live one). */
  async ensure(id: string): Promise<View | undefined> {
    if (!RECORDING_ID.test(id)) return undefined;
    try {
      const view = await this.load(id);
      view.lastUsed = this.now();
      return view;
    } catch (err) {
      this.deps.logger.debug(`recording view ${id}: ${errorMessage(err)}`);
      return undefined;
    }
  }

  /** REST for a view (`?view=<id>`). */
  async handleApi(id: string, req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): Promise<void> {
    const view = await this.ensure(id);
    if (!view) {
      sendError(res, 404, 'This recording is not open', 'recorder.notOpen');
      return;
    }
    const rest = new URLSearchParams(query);
    rest.delete('view');
    await view.api(req, res, pathname, rest);
  }

  /** WS /ui?view=<id>: undefined when the recording cannot be shown (the caller attaches the live channel then). */
  async attach(id: string, ws: () => Promise<WebSocket | undefined>, resume?: UiResumeRequest): Promise<boolean> {
    const view = await this.ensure(id);
    if (!view) return false;
    const socket = await ws();
    if (!socket) return true;
    view.lastUsed = this.now();
    view.channel.attach(socket, resume);
    return true;
  }

  /** Server-wide messages (settings, mocks, drivers, notices, flows) reach windows showing a recording too. */
  broadcast(message: ServerToUi): void {
    for (const v of this.views.values()) {
      try {
        v.channel.broadcast(message);
      } catch (err) {
        this.deps.logger.debug(`recording view ${v.id}: ${errorMessage(err)}`);
      }
    }
  }

  /** "Back to live" (DELETE /api/recordings/:id/open): dropped now when nobody else shows it, else once idle. */
  release(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    if (view.channel.size === 0) this.drop(id);
    else view.lastUsed = 0;
  }

  /** The recording was deleted: windows showing it reconnect (and land on the live data). */
  close(id: string): void {
    this.drop(id, 4004, 'This recording was deleted');
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const id of [...this.views.keys()]) this.drop(id, 1001, 'Dürbün is shutting down');
  }

  private load(id: string): Promise<View> {
    const known = this.views.get(id);
    if (known) return Promise.resolve(known);
    const pending = this.loading.get(id);
    if (pending) return pending;
    const run = this.read(id).finally(() => this.loading.delete(id));
    this.loading.set(id, run);
    return run;
  }

  private async read(id: string): Promise<View> {
    if (!RECORDING_ID.test(id)) throw new HttpError(404, 'Recording not found', 'recorder.unknown');
    if (id === this.deps.liveId()) throw new HttpError(409, 'This recording is the session being captured now: its data is the live data', 'recorder.live');
    const recording = await summarize(this.deps.root, id, this.deps.liveId());
    if (!recording) throw new HttpError(404, 'Recording not found', 'recorder.unknown');
    const settings = this.deps.settings();
    let read: Awaited<ReturnType<typeof readRecording>>;
    try {
      read = await readRecording(this.deps.root, id, {
        maxLogs: settings.maxLogEntries,
        maxRequests: settings.maxNetworkEntries,
        maxBodyBytes: settings.maxBodyStoreMB * MB,
      }, this.deps.version);
    } catch (err) {
      throw new HttpError(422, `The recording could not be read: ${errorMessage(err)}`, 'recorder.unreadable', { error: errorMessage(err) });
    }
    const hub = this.deps.createHub({ ...settings });
    try {
      hub.importSession(read.data, `recording ${localStamp(recording.startedAt)}`);
    } catch (err) {
      hub.dispose();
      throw new HttpError(422, `The recording could not be read: ${errorMessage(err)}`, 'recorder.unreadable', { error: errorMessage(err) });
    }
    const loaded = { logs: hub.getLogCount(), requests: hub.getNetwork().length };
    const opened: SessionRecordingOpen = {
      recording,
      loaded,
      left: {
        logs: read.left.logs + Math.max(0, read.loaded.logs - loaded.logs),
        requests: read.left.requests + Math.max(0, read.loaded.requests - loaded.requests),
      },
    };
    if (read.damaged > 0) opened.damaged = read.damaged;
    const wired = this.deps.wire(hub, recording);
    const view: View = {
      id,
      hub,
      channel: wired.channel,
      api: wired.api,
      opened,
      lastUsed: this.now(),
      dispose: () => {
        wired.dispose();
        hub.dispose();
      },
    };
    this.views.set(id, view);
    this.deps.logger.info(`opened recording ${id}: ${loaded.logs} line(s), ${loaded.requests} request(s)`);
    this.trimViews(id);
    return view;
  }

  private trimViews(keep: string): void {
    const max = this.deps.maxViews ?? MAX_VIEWS;
    if (this.views.size <= max) return;
    const idle = [...this.views.values()].filter((v) => v.id !== keep && v.channel.size === 0).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const v of idle) {
      if (this.views.size <= max) break;
      this.drop(v.id);
    }
  }

  private dropIdle(): void {
    const idleMs = this.deps.idleMs ?? IDLE_MS;
    const now = this.now();
    for (const v of [...this.views.values()]) if (v.channel.size === 0 && now - v.lastUsed >= idleMs) this.drop(v.id);
  }

  private drop(id: string, code = 1000, reason = 'Recording closed'): void {
    const view = this.views.get(id);
    if (!view) return;
    this.views.delete(id);
    try {
      view.channel.closeAll(code, reason);
      view.dispose();
    } catch (err) {
      this.deps.logger.warn(`closing recording view ${id}: ${errorMessage(err)}`);
    }
  }
}
