/**
 * REST API (SPEC §5.4). Access control happens before this handler is called (security.ts).
 *
 *   GET  /api/health                              { ok, name: 'durbun', version }
 *   GET  /api/network/:id                         NetworkDetail
 *   GET  /api/network/:id/body/(request|response) raw bytes, original Content-Type (?download=1)
 *   POST /api/network/search                      { text, ids?, caseSensitive? } → { ids }
 *   POST /api/har                                 { ids? } → HAR 1.2 download
 *   GET  /api/export?deviceId=&appId=             SessionExport download
 *   POST /api/import[?name=file]                  SessionExport body → { deviceIds }
 *   GET  /api/doctor                              ToolCheck[]
 *   POST /api/upload?name=<file>                  raw body (≤ 2 GB) → { file, name, size }
 *   GET  /api/files/:name                         a file from the temp directory (?download=1)
 */
import { randomBytes } from 'node:crypto';
import { createWriteStream, promises as fsp } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { PRODUCT_NAME, type NetworkDetail, type SessionExport, type ToolCheck } from '@durbun/protocol';
import { isPlainObject } from '../config';
import type { Hub, Logger } from '../types';
import { buildHar, headerValue } from './har';
import { streamJson } from './jsonStream';
import { extensionFor } from './mime';
import { isInside, SANDBOX_CSP, sendFile, statFile } from './static';
import {
  API_HEADERS,
  contentDisposition,
  errorMessage,
  fileTimestamp,
  formatBytes,
  HttpError,
  isTruthyParam,
  queryString,
  readJson,
  sendError,
  sendJson,
} from './util';

export const UPLOAD_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
/** Stays below V8's maximum string length so the body can be decoded and parsed. */
export const IMPORT_LIMIT_BYTES = 500 * 1024 * 1024;
const JSON_LIMIT_BYTES = 16 * 1024 * 1024;

export interface ApiDeps {
  hub: Hub;
  /** Directory for uploads and driver-generated files (served at /api/files/:name). */
  tempDir: string;
  logger: Logger;
  version: string;
  runDoctor(): Promise<ToolCheck[]>;
  uploadLimitBytes?: number;
  importLimitBytes?: number;
}

export type ApiHandler = (req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams) => Promise<void>;

/** Safe file name for an upload: basename only, ASCII letters/digits/._-, max 120 chars, extension kept. */
export function safeUploadName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  let s = base
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+/, '');
  if (s.length > 120) {
    const ext = path.extname(s).slice(0, 16);
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s || 'upload.bin';
}

/** Light structural validation; the hub re-assigns ids and owns the details. */
export function validateSessionExport(raw: unknown): SessionExport {
  if (!isPlainObject(raw)) throw new HttpError(400, 'Not a Dürbün session file (expected a JSON object)', 'import.invalid');
  if (raw.format !== 'durbun-session') throw new HttpError(400, 'Not a Dürbün session file (format is not "durbun-session")', 'import.invalid');
  if (raw.version !== 1) throw new HttpError(400, `Unsupported session file version ${String(raw.version)}`, 'import.version');
  for (const key of ['devices', 'apps', 'logs', 'network'] as const) {
    if (!Array.isArray(raw[key])) throw new HttpError(400, `Session file is missing the "${key}" list`, 'import.invalid');
  }
  if (raw.metrics !== undefined && !Array.isArray(raw.metrics)) throw new HttpError(400, 'Session file has an invalid "metrics" list', 'import.invalid');
  const objects = (v: unknown) => (Array.isArray(v) ? v.filter(isPlainObject) : undefined);
  const data: SessionExport = {
    format: 'durbun-session',
    version: 1,
    exportedAt: typeof raw.exportedAt === 'number' ? raw.exportedAt : Date.now(),
    server: isPlainObject(raw.server) && typeof raw.server.version === 'string' ? { version: raw.server.version } : { version: 'unknown' },
    devices: objects(raw.devices) as unknown as SessionExport['devices'],
    apps: objects(raw.apps) as unknown as SessionExport['apps'],
    logs: objects(raw.logs) as unknown as SessionExport['logs'],
    network: objects(raw.network) as unknown as SessionExport['network'],
  };
  const metrics = objects(raw.metrics);
  if (metrics) data.metrics = metrics as unknown as SessionExport['metrics'];
  return data;
}

/** Label for an imported session: the file name without extension, else the export date. */
export function importLabel(fileName: string | undefined, exportedAt: number): string {
  if (fileName) {
    const base = fileName.split(/[\\/]/).pop()!.replace(/\.(durbun\.json|json|durbun)$/i, '').trim();
    if (base) return base.slice(0, 80);
  }
  const d = new Date(exportedAt);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function withUtf8Charset(contentType: string): string {
  if (/;\s*charset=/i.test(contentType)) return contentType.replace(/(;\s*charset=)[^;]*/i, '$1utf-8');
  return `${contentType}; charset=utf-8`;
}

/** Download name for a body: the URL's file name when it has one, else "<last path segment>-<which>.<ext>". */
export function bodyFileName(d: NetworkDetail, which: 'request' | 'response', contentType: string | undefined): string {
  let last = '';
  let host = '';
  try {
    const u = new URL(d.url);
    host = u.hostname;
    last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
  } catch {
    /* keep defaults */
  }
  if (which === 'response' && /\.[A-Za-z0-9]{1,8}$/.test(last)) return last;
  const stem = last ? last.replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'body' : host || 'body';
  return `${stem}-${which}.${extensionFor(contentType)}`;
}

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    throw new HttpError(400, 'Malformed URL', 'url.invalid');
  }
}

function methodNotAllowed(allow: string): HttpError & { allow: string } {
  return Object.assign(new HttpError(405, 'Method not allowed', 'method.notAllowed'), { allow });
}

export function createApiHandler(deps: ApiDeps): ApiHandler {
  const uploadLimit = deps.uploadLimitBytes ?? UPLOAD_LIMIT_BYTES;
  const importLimit = deps.importLimitBytes ?? IMPORT_LIMIT_BYTES;
  const tempDir = path.resolve(deps.tempDir);

  function requireMethod(req: IncomingMessage, ...allowed: string[]): void {
    if (!allowed.includes(req.method ?? 'GET')) throw methodNotAllowed(allowed.join(', '));
  }

  async function networkDetail(res: ServerResponse, id: string): Promise<void> {
    const d = deps.hub.getNetworkDetail(id);
    if (!d) throw new HttpError(404, `Request ${id} not found`, 'net.unknown');
    sendJson(res, 200, d);
  }

  function networkBody(req: IncomingMessage, res: ServerResponse, id: string, which: 'request' | 'response', query: URLSearchParams): void {
    const d = deps.hub.getNetworkDetail(id);
    if (!d) throw new HttpError(404, `Request ${id} not found`, 'net.unknown');
    const body = which === 'request' ? d.requestBody : d.responseBody;
    if (!body) {
      if (d.bodyEvicted) throw new HttpError(410, 'The body was evicted from memory (body budget)', 'body.evicted');
      throw new HttpError(404, `This request has no ${which} body`, 'body.none');
    }
    const bytes = Buffer.from(body.data, body.encoding === 'base64' ? 'base64' : 'utf8');
    const original =
      (which === 'request' ? d.requestContentType : d.responseContentType) ??
      headerValue(which === 'request' ? d.requestHeaders : d.responseHeaders, 'content-type');
    const contentType =
      body.encoding === 'utf8' ? withUtf8Charset(original ?? 'text/plain') : (original ?? 'application/octet-stream');
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(bytes.length),
      'Content-Security-Policy': SANDBOX_CSP,
      'X-Durbun-Body-Size': String(body.size),
      ...API_HEADERS,
    };
    if (body.truncated) headers['X-Durbun-Truncated'] = '1';
    if (isTruthyParam(query, 'download')) headers['Content-Disposition'] = contentDisposition(bodyFileName(d, which, original));
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }

  async function search(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req, JSON_LIMIT_BYTES);
    if (!isPlainObject(body) || typeof body.text !== 'string') throw new HttpError(400, 'Expected { text: string }', 'search.invalid');
    let ids: string[] | undefined;
    if (body.ids !== undefined && body.ids !== null) {
      if (!Array.isArray(body.ids) || body.ids.some((x) => typeof x !== 'string')) {
        throw new HttpError(400, 'ids must be a list of strings', 'search.invalid');
      }
      ids = body.ids as string[];
    }
    const caseSensitive = body.caseSensitive === true;
    const result =
      body.text === ''
        ? (ids ?? deps.hub.getNetwork().map((e) => e.id))
        : deps.hub.searchNetwork(body.text, ids ? { ids, caseSensitive } : { caseSensitive });
    sendJson(res, 200, { ids: result });
  }

  async function har(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req, JSON_LIMIT_BYTES);
    let ids: string[] | undefined;
    if (body !== undefined && body !== null) {
      if (!isPlainObject(body)) throw new HttpError(400, 'Expected { ids?: string[] }', 'har.invalid');
      if (body.ids !== undefined && body.ids !== null) {
        if (!Array.isArray(body.ids) || body.ids.some((x) => typeof x !== 'string')) {
          throw new HttpError(400, 'ids must be a list of strings', 'har.invalid');
        }
        ids = body.ids as string[];
      }
    }
    const details: NetworkDetail[] = [];
    for (const id of ids ?? deps.hub.getNetwork().map((e) => e.id)) {
      const d = deps.hub.getNetworkDetail(id);
      if (d) details.push(d);
    }
    const doc = buildHar(details, { name: PRODUCT_NAME, version: deps.version });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': contentDisposition(`durbun-${fileTimestamp()}.har`),
      ...API_HEADERS,
    });
    await streamJson(res, doc, 3);
    res.end();
  }

  async function exportSession(res: ServerResponse, query: URLSearchParams): Promise<void> {
    const scope: { deviceId?: string; appId?: string } = {};
    const deviceId = queryString(query, 'deviceId');
    const appId = queryString(query, 'appId');
    if (deviceId) scope.deviceId = deviceId;
    if (appId) scope.appId = appId;
    const data = deps.hub.exportSession(scope);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': contentDisposition(`durbun-${fileTimestamp()}.durbun.json`),
      ...API_HEADERS,
    });
    await streamJson(res, data, 2);
    res.end();
  }

  async function importSession(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
    const raw = await readJson(req, importLimit);
    const data = validateSessionExport(raw);
    const label = importLabel(queryString(query, 'name'), data.exportedAt);
    let result: { deviceIds: string[] };
    try {
      result = deps.hub.importSession(data, label);
    } catch (err) {
      throw new HttpError(400, `Import failed: ${errorMessage(err)}`, 'import.failed');
    }
    sendJson(res, 200, { deviceIds: result.deviceIds });
  }

  async function upload(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > uploadLimit) {
      req.resume();
      throw new HttpError(413, `File is too large (limit ${formatBytes(uploadLimit)})`, 'upload.tooLarge');
    }
    const name = safeUploadName(queryString(query, 'name') ?? 'upload.bin');
    await fsp.mkdir(tempDir, { recursive: true });
    const finalPath = path.join(tempDir, `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}-${name}`);
    const partPath = `${finalPath}.part`;
    let size = 0;
    const out = createWriteStream(partPath, { flags: 'wx', mode: 0o600 });
    // 'close' also fires after a destroy() that raced with the asynchronous open — only then is it safe to delete.
    const outClosed = new Promise<void>((resolve) => out.once('close', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      let failed = false;
      const fail = (err: Error) => {
        if (failed) return;
        failed = true;
        req.unpipe(out);
        out.destroy();
        req.resume(); // drain the rest so a response can still be sent
        reject(err);
      };
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > uploadLimit) fail(new HttpError(413, `File is too large (limit ${formatBytes(uploadLimit)})`, 'upload.tooLarge'));
      });
      req.on('error', fail);
      req.on('close', () => {
        if (!req.complete) fail(new HttpError(400, 'Upload aborted', 'upload.aborted'));
      });
      out.on('error', (err) => fail(new HttpError(500, `Could not save the upload: ${err.message}`, 'upload.failed')));
      out.on('finish', () => {
        if (!failed) resolve();
      });
      req.pipe(out);
    }).catch(async (err) => {
      out.destroy();
      await Promise.race([outClosed, new Promise((r) => setTimeout(r, 2_000).unref())]);
      await fsp.rm(partPath, { force: true }).catch(() => {});
      throw err;
    });
    await outClosed;
    await fsp.rename(partPath, finalPath);
    deps.logger.debug(`upload saved: ${finalPath} (${formatBytes(size)})`);
    sendJson(res, 200, { file: finalPath, name, size });
  }

  async function file(req: IncomingMessage, res: ServerResponse, name: string, query: URLSearchParams): Promise<void> {
    if (!name || name === '.' || name === '..' || name.startsWith('.') || /[\\/\0]/.test(name)) {
      throw new HttpError(404, 'File not found', 'file.unknown');
    }
    const filePath = path.join(tempDir, name);
    if (path.dirname(filePath) !== tempDir) throw new HttpError(404, 'File not found', 'file.unknown');
    const stat = await statFile(filePath);
    if (!stat?.isFile()) throw new HttpError(404, 'File not found', 'file.unknown');
    const [real, realRoot] = await Promise.all([fsp.realpath(filePath), fsp.realpath(tempDir)]);
    if (!isInside(realRoot, real) || real === realRoot) throw new HttpError(404, 'File not found', 'file.unknown');
    const headers: Record<string, string> = {};
    if (isTruthyParam(query, 'download')) headers['Content-Disposition'] = contentDisposition(name);
    sendFile(req, res, real, stat, { cacheControl: 'no-cache', sandboxActive: true, headers });
  }

  async function route(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): Promise<void> {
    const segs = pathname.split('/').slice(2).filter((s, i, all) => s !== '' || i < all.length - 1).map(decodeSegment);
    const method = req.method ?? 'GET';
    const [first, second, third, fourth] = segs;
    switch (first) {
      case 'health':
        requireMethod(req, 'GET', 'HEAD');
        sendJson(res, 200, { ok: true, name: 'durbun', version: deps.version });
        return;
      case 'network': {
        if (second === 'search' && segs.length === 2 && method === 'POST') return search(req, res);
        if (!second) throw new HttpError(404, 'Not found', 'api.notFound');
        if (segs.length === 2) {
          requireMethod(req, 'GET', 'HEAD');
          return networkDetail(res, second);
        }
        if (segs.length === 4 && third === 'body' && (fourth === 'request' || fourth === 'response')) {
          requireMethod(req, 'GET', 'HEAD');
          return networkBody(req, res, second, fourth, query);
        }
        throw new HttpError(404, 'Not found', 'api.notFound');
      }
      case 'har':
        if (segs.length !== 1) break;
        requireMethod(req, 'POST');
        return har(req, res);
      case 'export':
        if (segs.length !== 1) break;
        requireMethod(req, 'GET');
        return exportSession(res, query);
      case 'import':
        if (segs.length !== 1) break;
        requireMethod(req, 'POST');
        return importSession(req, res, query);
      case 'doctor':
        if (segs.length !== 1) break;
        requireMethod(req, 'GET');
        sendJson(res, 200, await deps.runDoctor());
        return;
      case 'upload':
        if (segs.length !== 1) break;
        requireMethod(req, 'POST', 'PUT');
        return upload(req, res, query);
      case 'files':
        if (segs.length !== 2) break;
        requireMethod(req, 'GET', 'HEAD');
        return file(req, res, second ?? '', query);
      default:
        break;
    }
    throw new HttpError(404, 'Not found', 'api.notFound');
  }

  return async (req, res, pathname, query) => {
    try {
      await route(req, res, pathname, query);
    } catch (err) {
      if (res.headersSent) {
        // Streaming already started (export/HAR) — the client sees a truncated download.
        deps.logger.warn(`${req.method} ${pathname} failed mid-response: ${errorMessage(err)}`);
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        const headers: Record<string, string> = {};
        if (err.status === 405 && 'allow' in err) headers.Allow = String((err as { allow: string }).allow);
        if (err.status === 413) headers.Connection = 'close';
        sendError(res, err.status, err.message, err.code, headers);
        return;
      }
      deps.logger.error(`${req.method} ${pathname} failed: ${errorMessage(err)}`);
      sendError(res, 500, `Internal error: ${errorMessage(err)}`, 'internal');
    }
  };
}
