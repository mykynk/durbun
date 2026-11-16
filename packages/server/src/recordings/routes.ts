/**
 * REST of the session recorder (SPEC §13, protocol recordings.ts):
 *
 *   GET    /api/recordings                  SessionRecordingList
 *   DELETE /api/recordings                  every recording but the one being written → SessionRecordingList
 *   DELETE /api/recordings/:id              → SessionRecordingList · 404 recorder.unknown · 409 recorder.live
 *   GET    /api/recordings/:id/export       SessionExport download (masked unless mask=0) · 404 · 409 · 422
 *   POST   /api/recordings/:id/open         SessionRecordingOpen · 404 · 409 recorder.live · 422 recorder.unreadable
 *   DELETE /api/recordings/:id/open         { ok: true } (the window went back to live: the view's memory is freed)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerSettings, SessionRecordingList } from '@durbun/protocol';
import { cleanSessionExport, localRoots, maskParam } from '../http/exportClean';
import { streamJson } from '../http/jsonStream';
import { API_HEADERS, contentDisposition, errorMessage, HttpError, sendJson } from '../http/util';
import type { SessionRecorder } from './recorder';
import { readRecording, RECORDING_ID, summarize } from './store';
import type { RecordingViews } from './views';

const MB = 1024 * 1024;

export interface RecordingRoutesDeps {
  recorder: SessionRecorder;
  views: RecordingViews;
  root: string;
  tempDir: string;
  settings(): ServerSettings;
  version: string;
}

function notAllowed(allow: string): HttpError & { allow: string } {
  return Object.assign(new HttpError(405, 'Method not allowed', 'method.notAllowed'), { allow });
}

const unknown = () => new HttpError(404, 'Recording not found', 'recorder.unknown');

/** "20261115-2140" (Mac time) for file names. */
function fileStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function recordingRoutes(deps: RecordingRoutesDeps): {
  prefixes: readonly string[];
  handle(req: IncomingMessage, res: ServerResponse, segs: string[], query: URLSearchParams): Promise<void>;
} {
  const list = (): Promise<SessionRecordingList> => deps.recorder.list();

  async function remove(id: string): Promise<void> {
    if (!RECORDING_ID.test(id)) throw unknown();
    if (id === deps.recorder.currentId) throw new HttpError(409, 'This recording is still being written: turn recording off first', 'recorder.live');
    deps.views.close(id);
    if (!(await deps.recorder.delete(id))) throw unknown();
  }

  async function exportOne(res: ServerResponse, id: string, query: URLSearchParams): Promise<void> {
    if (!RECORDING_ID.test(id)) throw unknown();
    const summary = await summarize(deps.root, id, deps.recorder.currentId);
    if (!summary) throw unknown();
    if (summary.state === 'recording') throw new HttpError(409, 'This recording is the session being captured now: export the live data instead', 'recorder.live');
    const s = deps.settings();
    let data;
    try {
      data = (await readRecording(deps.root, id, { maxLogs: s.maxLogEntries, maxRequests: s.maxNetworkEntries, maxBodyBytes: s.maxBodyStoreMB * MB }, deps.version)).data;
    } catch (err) {
      throw new HttpError(422, `The recording could not be read: ${errorMessage(err)}`, 'recorder.unreadable', { error: errorMessage(err) });
    }
    const out = cleanSessionExport(data, { mask: maskParam(query.get('mask')), roots: localRoots([deps.tempDir]) });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': contentDisposition(`durbun-recording-${fileStamp(summary.startedAt)}.durbun.json`),
      ...API_HEADERS,
    });
    await streamJson(res, out, 2);
    res.end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse, segs: string[], query: URLSearchParams): Promise<void> {
    const method = req.method ?? 'GET';
    const [, id, action] = segs;
    if (segs.length === 1) {
      if (method === 'GET' || method === 'HEAD') return sendJson(res, 200, await list());
      if (method === 'DELETE') {
        const ids = await deps.recorder.deleteAll();
        for (const removed of ids) deps.views.close(removed);
        return sendJson(res, 200, await list());
      }
      throw notAllowed('GET, HEAD, DELETE');
    }
    if (segs.length === 2 && id) {
      if (method !== 'DELETE') throw notAllowed('DELETE');
      await remove(id);
      return sendJson(res, 200, await list());
    }
    if (segs.length === 3 && id && action === 'export') {
      if (method !== 'GET') throw notAllowed('GET');
      return exportOne(res, id, query);
    }
    if (segs.length === 3 && id && action === 'open') {
      if (method === 'POST') return sendJson(res, 200, await deps.views.open(id));
      if (method === 'DELETE') {
        deps.views.release(id);
        return sendJson(res, 200, { ok: true });
      }
      throw notAllowed('POST, DELETE');
    }
    throw new HttpError(404, 'Not found', 'api.notFound');
  }

  return { prefixes: ['recordings'], handle };
}
