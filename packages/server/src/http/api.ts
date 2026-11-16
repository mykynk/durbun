/**
 * REST API (SPEC §5.4). Access control happens before this handler is called (security.ts).
 *
 *   GET  /api/health                              { ok, name: 'durbun', version }
 *   GET  /api/summary                             { devices, apps } connected right now (menu-bar line)
 *   GET  /api/network/:id                         NetworkDetail
 *   GET  /api/network/:id/body/(request|response) raw bytes, original Content-Type (?download=1)
 *   GET  /api/network/:id/messages?after&limit    StreamMessagesPage (WebSocket / SSE messages after a seq)
 *   POST /api/network/search                      { text, ids?, caseSensitive? } → { ids }
 *   POST /api/har                                 { ids? } → HAR 1.2 download
 *   GET  /api/export?deviceId=&appId=&bundleId=&fromTs=&toTs=&mask=0   SessionExport download (masked unless mask=0)
 *   POST /api/bug-report                          BugReportRequest → .zip (report.md, logs, HAR, screenshot, recording)
 *   POST /api/import[?name=file]                  SessionExport body → { deviceIds }
 *   GET  /api/doctor                              ToolCheck[]
 *   POST /api/upload?name=<file>                  raw body (≤ 2 GB) → { file, name, size }
 *   GET  /api/files/:name                         a file from the temp directory (?download=1)
 *   GET  /api/files/crash/:udid/:name             a copied iOS crash report (<tempDir>/crash/<udid>/*.ips), as a download
 *   GET|DELETE /api/media[?deviceId=], GET|DELETE /api/media/:id   screenshots and recordings kept on disk (media.ts)
 *   GET /api/android/wireless, POST /api/android/wireless/pair|connect   Android pairing over Wi-Fi (androidWireless.ts)
 *   GET|PUT /api/slack, POST /api/slack/send       Send to Slack (slack.ts)
 *   /api/flows…, /api/flow-runs…, /api/flow-environments, /api/packages…, /api/backup…, /api/ui-prefs
 *                                                 flows and Dürbün packages (flows/module.ts)
 */
import { randomBytes } from 'node:crypto';
import { createWriteStream, promises as fsp } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { PRODUCT_NAME, type NetworkDetail, type SessionExport, type StreamMessage, type StreamMessagesPage, type ToolCheck } from '@durbun/protocol';
import { isPlainObject } from '../config';
import { sessionVersionProblem } from '../hub/sanitize';
import type { Hub, Logger } from '../types';
import { cleanHarDetails, cleanSessionExport, localRoots, maskParam } from './exportClean';
import { bugReportZip, crashFileParts, parseBugReportRequest, sliceSessionExport, tempFileName } from './bugReport';
import { buildHar, headerValue } from './har';
import { DESKTOP_DEVICE_ID } from './replay';
import { parseJsonBuffer } from './jsonParse';
import type { SlackStore } from './slack';
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
  readBody,
  readJson,
  sendError,
  sendJson,
} from './util';

export const UPLOAD_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
/**
 * Largest session import. The body is parsed member by member and list element by element (jsonParse.ts),
 * never decoded into one string, so its parsed form is what has to fit in the heap. Not lowered to "the
 * largest export": with the default caps an export is already ~0.5 GB (256 MB of log text, 256 MB of bodies).
 */
export const IMPORT_LIMIT_BYTES = 500 * 1024 * 1024;
const JSON_LIMIT_BYTES = 16 * 1024 * 1024;
/** A Slack message is at most 40,000 characters (up to 4 bytes each in UTF-8, more as JSON escapes). */
const SLACK_BODY_LIMIT_BYTES = 1024 * 1024;

export interface ApiDeps {
  hub: Hub;
  /** Directory for uploads and driver-generated files (served at /api/files/:name). */
  tempDir: string;
  logger: Logger;
  version: string;
  runDoctor(): Promise<ToolCheck[]>;
  uploadLimitBytes?: number;
  importLimitBytes?: number;
  /** Send to Slack; without it /api/slack answers 404. */
  slack?: SlackStore;
  /** Route groups served by other modules (flows, packages, backup): the first path segment picks one. */
  modules?: readonly { prefixes: readonly string[]; handle(req: IncomingMessage, res: ServerResponse, segs: string[], query: URLSearchParams): Promise<void> }[];
}

export type ApiHandler = (req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams) => Promise<void>;

/** Device UDID as the iOS driver names its crash folder (hex + dashes; simulator UUIDs too). */
const CRASH_UDID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
/** Crash report copy name (platform/ios localCrashName keeps [A-Za-z0-9._-]): no dot files, only .ips. */
const CRASH_FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}\.ips$/i;

/** Is `udid` / `name` a crash report copy the server may serve (GET /api/files/crash/:udid/:name)? */
export function isServableCrashFile(udid: string, name: string): boolean {
  return CRASH_UDID.test(udid) && CRASH_FILE.test(name) && !name.includes('..');
}

/** Name POST /api/upload gives a file in the temp directory: "<time36>-<6 hex>-<safe name>". */
export function uploadFileName(name: string): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}-${safeUploadName(name)}`;
}

/** Is `file` an upload saved by POST /api/upload (directly inside `tempDir`, named by uploadFileName)? */
export function isUploadedFile(tempDir: string, file: string): boolean {
  if (!path.isAbsolute(file)) return false;
  const resolved = path.resolve(file);
  return path.dirname(resolved) === path.resolve(tempDir) && /^[0-9a-z]+-[0-9a-f]{6}-[A-Za-z0-9]/.test(path.basename(resolved));
}

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

interface ImportBaseline {
  lastLogId: number;
  logs: number;
  requestIds: Set<string>;
}

function importBaseline(hub: Pick<Hub, 'getLogs' | 'getNetwork'>): ImportBaseline {
  const logs = hub.getLogs();
  return { lastLogId: logs.at(-1)?.id ?? 0, logs: logs.length, requestIds: new Set(hub.getNetwork().map((e) => e.id)) };
}

/**
 * What an import really loaded (the import shares the live limits): lines and requests of the file that are in
 * Dürbün now, those that did not fit or were not valid, and live ones the import pushed out. The UI says so
 * instead of a file silently losing its older half.
 */
export function importCounts(
  hub: Pick<Hub, 'getLogs' | 'getNetwork'>,
  before: ImportBaseline,
  data: Pick<SessionExport, 'logs' | 'network'>,
): { imported: { logs: number; requests: number }; dropped: { logs: number; requests: number }; evicted: { logs: number; requests: number } } {
  let importedLogs = 0;
  let liveLogs = 0;
  for (const e of hub.getLogs()) {
    if (e.id > before.lastLogId) importedLogs++;
    else liveLogs++;
  }
  let importedRequests = 0;
  let liveRequests = 0;
  for (const e of hub.getNetwork()) {
    if (before.requestIds.has(e.id)) liveRequests++;
    else importedRequests++;
  }
  const fileLogs = Array.isArray(data.logs) ? data.logs.length : 0;
  const fileRequests = Array.isArray(data.network) ? data.network.length : 0;
  return {
    imported: { logs: importedLogs, requests: importedRequests },
    dropped: { logs: Math.max(0, fileLogs - importedLogs), requests: Math.max(0, fileRequests - importedRequests) },
    evicted: { logs: Math.max(0, before.logs - liveLogs), requests: Math.max(0, before.requestIds.size - liveRequests) },
  };
}

/**
 * GET /api/summary (the Mac app's menu-bar line): devices and app sessions connected right now. A device counts
 * while it is attached in any state but 'disconnected' (an unauthorized phone is plugged in too); the virtual
 * desktop device and imported recordings never count.
 */
export function connectedSummary(hub: Pick<Hub, 'getDevices' | 'getApps'>): { devices: number; apps: number } {
  const counted = (deviceId: string) => deviceId !== DESKTOP_DEVICE_ID && !deviceId.startsWith('import:');
  const devices = hub.getDevices().filter((d) => d.state !== 'disconnected' && counted(d.id)).length;
  const apps = hub.getApps().filter((a) => a.connected && counted(a.deviceId)).length;
  return { devices, apps };
}

/** Light structural validation; the hub re-assigns ids and owns the details. */
export function validateSessionExport(raw: unknown): SessionExport {
  if (!isPlainObject(raw)) throw new HttpError(400, 'Not a Dürbün session file (expected a JSON object)', 'import.invalid');
  if (raw.format !== 'durbun-session') throw new HttpError(400, 'Not a Dürbün session file (format is not "durbun-session")', 'import.invalid');
  const versionProblem = sessionVersionProblem(raw.version);
  if (versionProblem) throw new HttpError(400, versionProblem, 'import.version', raw.version === undefined || raw.version === null ? undefined : { version: String(raw.version).slice(0, 40) });
  for (const key of ['devices', 'apps', 'logs', 'network'] as const) {
    if (!Array.isArray(raw[key])) throw new HttpError(400, `Session file is missing the "${key}" list`, 'import.invalid', { field: key });
  }
  if (raw.metrics !== undefined && !Array.isArray(raw.metrics)) {
    throw new HttpError(400, 'Session file has an invalid "metrics" list', 'import.invalid', { field: 'metrics' });
  }
  const objects = (v: unknown) => (Array.isArray(v) ? v.filter(isPlainObject) : undefined);
  const data: SessionExport = {
    format: 'durbun-session',
    // A newer version passes through: the hub imports what it knows and says so in its log.
    version: raw.version as SessionExport['version'],
    exportedAt: typeof raw.exportedAt === 'number' ? raw.exportedAt : Date.now(),
    server: isPlainObject(raw.server) && typeof raw.server.version === 'string' ? { version: raw.server.version } : { version: 'unknown' },
    devices: objects(raw.devices) as unknown as SessionExport['devices'],
    apps: objects(raw.apps) as unknown as SessionExport['apps'],
    logs: objects(raw.logs) as unknown as SessionExport['logs'],
    network: objects(raw.network) as unknown as SessionExport['network'],
  };
  const metrics = objects(raw.metrics);
  if (metrics) data.metrics = metrics as unknown as SessionExport['metrics'];
  if (raw.deviceApps !== undefined && !Array.isArray(raw.deviceApps)) {
    throw new HttpError(400, 'Session file has an invalid "deviceApps" list', 'import.invalid', { field: 'deviceApps' });
  }
  const deviceApps = objects(raw.deviceApps);
  if (deviceApps) data.deviceApps = deviceApps as unknown as SessionExport['deviceApps'];
  if (raw.masked === true) data.masked = true;
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

  /** The detail with every stream message the hub holds (HAR). */
  function withStreamMessages(d: NetworkDetail): NetworkDetail {
    const messages: StreamMessage[] = [];
    let after = 0;
    for (;;) {
      const page = deps.hub.getStreamMessages?.(d.id, { after, limit: 2_000 });
      if (!page || page.messages.length === 0) break;
      messages.push(...page.messages);
      after = page.messages.at(-1)!.seq;
      if (!page.more) break;
    }
    return messages.length ? { ...d, streamMessages: messages } : d;
  }

  /** GET /api/network/:id/messages?after=<seq>&limit=<n>: the stream's messages after a seq (StreamMessagesPage). */
  function streamMessages(res: ServerResponse, id: string, query: URLSearchParams): void {
    const after = Number(query.get('after') ?? 0);
    const limit = Number(query.get('limit') ?? 500);
    if (!Number.isFinite(after) || after < 0 || !Number.isFinite(limit) || limit < 1) {
      throw new HttpError(400, 'after must be a seq (0 or more) and limit a positive number', 'params.invalid', { field: !Number.isFinite(after) || after < 0 ? 'after' : 'limit' });
    }
    const page = deps.hub.getStreamMessages?.(id, { after, limit });
    if (!page) {
      if (!deps.hub.getNetworkDetail(id)) throw new HttpError(404, `Request ${id} not found`, 'net.unknown');
      sendJson(res, 200, { messages: [], more: false } satisfies StreamMessagesPage);
      return;
    }
    sendJson(res, 200, page satisfies StreamMessagesPage);
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
    if (body.text === '') {
      sendJson(res, 200, { ids: ids ?? deps.hub.getNetwork().map((e) => e.id) });
      return;
    }
    const opts = ids ? { ids, caseSensitive } : { caseSensitive };
    if (!deps.hub.searchNetworkAsync) {
      sendJson(res, 200, { ids: deps.hub.searchNetwork(body.text, opts) });
      return;
    }
    // The UI aborts its search on every keystroke: stop scanning bodies once the request is gone.
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) abort.abort();
    };
    res.once('close', onClose);
    try {
      sendJson(res, 200, { ids: await deps.hub.searchNetworkAsync(body.text, { ...opts, signal: abort.signal }) });
    } catch (err) {
      if (abort.signal.aborted) {
        deps.logger.debug('network search stopped: the client went away');
        return;
      }
      throw err;
    } finally {
      res.off('close', onClose);
    }
  }

  async function har(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req, JSON_LIMIT_BYTES);
    let ids: string[] | undefined;
    // Masked unless the caller asks for the raw file (mask: false).
    let mask = true;
    if (body !== undefined && body !== null) {
      if (!isPlainObject(body)) throw new HttpError(400, 'Expected { ids?: string[], mask?: boolean }', 'har.invalid');
      if (body.mask !== undefined && body.mask !== null) {
        if (typeof body.mask !== 'boolean') throw new HttpError(400, 'mask must be true or false', 'har.invalid');
        mask = body.mask;
      }
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
      if (d) details.push(d.stream ? withStreamMessages(d) : d);
    }
    const doc = buildHar(cleanHarDetails(details, { mask }), { name: PRODUCT_NAME, version: deps.version });
    if (mask) doc.log._durbun = { ...doc.log._durbun, masked: true };
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': contentDisposition(`durbun-${fileTimestamp()}.har`),
      ...API_HEADERS,
    });
    await streamJson(res, doc, 3);
    res.end();
  }

  async function exportSession(res: ServerResponse, query: URLSearchParams): Promise<void> {
    const scope: { deviceId?: string; appId?: string; bundleId?: string } = {};
    const deviceId = queryString(query, 'deviceId');
    const appId = queryString(query, 'appId');
    const bundleId = queryString(query, 'bundleId');
    if (deviceId) scope.deviceId = deviceId;
    if (appId) scope.appId = appId;
    if (bundleId) {
      // A device app is named by its device and bundle id (an SDK-less build has no session id).
      if (!deviceId) throw new HttpError(400, 'bundleId needs deviceId (the device the app is on)', 'export.bundleNeedsDevice');
      if (appId) throw new HttpError(400, 'Give either appId or bundleId, not both', 'export.scopeConflict');
      scope.bundleId = bundleId;
    }
    let session = deps.hub.exportSession(scope);
    // A time window (epoch ms): the lines, requests and samples inside it.
    const fromTs = timeParam(query, 'fromTs');
    const toTs = timeParam(query, 'toTs');
    if (fromTs !== undefined || toTs !== undefined) session = sliceSessionExport(session, fromTs ?? 0, toTs ?? Number.MAX_SAFE_INTEGER);
    const data = cleanSessionExport(session, { mask: maskParam(query.get('mask')), roots: localRoots([tempDir]) });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': contentDisposition(`durbun-${fileTimestamp()}.durbun.json`),
      ...API_HEADERS,
    });
    await streamJson(res, data, 2);
    res.end();
  }

  function timeParam(query: URLSearchParams, key: string): number | undefined {
    const raw = queryString(query, key);
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${key} must be a time in epoch milliseconds`, 'export.invalidTime');
    return n;
  }

  async function bugReport(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const r = parseBugReportRequest(await readJson(req, JSON_LIMIT_BYTES));
    const mask = r.mask !== false;
    const skipped: string[] = [];
    let har: unknown;
    if (r.requestIds?.length) {
      const details: NetworkDetail[] = [];
      for (const id of r.requestIds) {
        const d = deps.hub.getNetworkDetail(id);
        if (d) details.push(d);
      }
      if (details.length) {
        const doc = buildHar(cleanHarDetails(details, { mask }), { name: PRODUCT_NAME, version: deps.version });
        if (mask) doc.log._durbun = { ...doc.log._durbun, masked: true };
        har = doc;
      }
    }
    let screenshot: { name: string; data: Buffer } | undefined;
    if (r.screenshot) {
      const name = tempFileName(r.screenshot);
      const found = await tempFile(name);
      const data = found ? await fsp.readFile(found.real).catch(() => undefined) : undefined;
      if (data) screenshot = { name, data };
      else skipped.push('screenshot');
    }
    let crashReport: { name: string; data: Buffer } | undefined;
    if (r.crashReport) {
      const parts = crashFileParts(r.crashReport);
      const found = parts ? await crashCopy(parts.udid, parts.name) : undefined;
      const data = found ? await fsp.readFile(found.real).catch(() => undefined) : undefined;
      if (parts && data) crashReport = { name: parts.name, data };
      else skipped.push('crashReport');
    }
    let recording: SessionExport | undefined;
    if (r.recording) {
      const { fromTs, toTs, ...scope } = r.recording;
      recording = cleanSessionExport(sliceSessionExport(deps.hub.exportSession(scope), fromTs, toTs), { mask, roots: localRoots([tempDir]) });
    }
    const zip = bugReportZip({ report: r.report, logs: r.logs, har, screenshot, crashReport, recording });
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': String(zip.length),
      'Content-Disposition': contentDisposition(`${r.name ?? `durbun-bug-${fileTimestamp()}`}.zip`),
      ...(skipped.length ? { 'X-Durbun-Skipped': skipped.join(',') } : {}),
      ...API_HEADERS,
    });
    res.end(zip);
  }

  async function importSession(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
    const raw = await parseJsonBuffer(await readBody(req, importLimit));
    const data = validateSessionExport(raw);
    const label = importLabel(queryString(query, 'name'), data.exportedAt);
    const before = importBaseline(deps.hub);
    let result: { deviceIds: string[] };
    try {
      result = deps.hub.importSession(data, label);
    } catch (err) {
      throw new HttpError(400, `Import failed: ${errorMessage(err)}`, 'import.failed', { detail: errorMessage(err) });
    }
    sendJson(res, 200, { deviceIds: result.deviceIds, ...importCounts(deps.hub, before, data) });
  }

  async function upload(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): Promise<void> {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > uploadLimit) {
      req.resume();
      throw new HttpError(413, `File is too large (limit ${formatBytes(uploadLimit)})`, 'upload.tooLarge');
    }
    const name = safeUploadName(queryString(query, 'name') ?? 'upload.bin');
    await fsp.mkdir(tempDir, { recursive: true });
    const finalPath = path.join(tempDir, uploadFileName(name));
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

  /** A file directly inside the temp dir (no dot files, no way out through a symlink), or undefined. */
  async function tempFile(name: string): Promise<{ real: string; stat: NonNullable<Awaited<ReturnType<typeof statFile>>> } | undefined> {
    if (!name || name === '.' || name === '..' || name.startsWith('.') || /[\\/\0]/.test(name)) return undefined;
    const filePath = path.join(tempDir, name);
    if (path.dirname(filePath) !== tempDir) return undefined;
    const stat = await statFile(filePath);
    if (!stat?.isFile()) return undefined;
    const [real, realRoot] = await Promise.all([fsp.realpath(filePath), fsp.realpath(tempDir)]).catch(() => [undefined, undefined]);
    if (!real || !realRoot || !isInside(realRoot, real) || real === realRoot) return undefined;
    return { real, stat };
  }

  /** An iOS crash report copy (`<tempDir>/crash/<udid>/<name>.ips`), or undefined. */
  async function crashCopy(udid: string, name: string): Promise<{ real: string; stat: NonNullable<Awaited<ReturnType<typeof statFile>>> } | undefined> {
    if (!isServableCrashFile(udid, name)) return undefined;
    const crashRoot = path.join(tempDir, 'crash');
    const dir = path.join(crashRoot, udid);
    const filePath = path.join(dir, name);
    if (path.dirname(filePath) !== dir || path.dirname(dir) !== crashRoot) return undefined;
    const stat = await statFile(filePath);
    if (!stat?.isFile()) return undefined;
    // Symlinks must not lead out of the crash folder of that device.
    const reals = await Promise.all([fsp.realpath(filePath), fsp.realpath(dir), fsp.realpath(tempDir)]).catch(() => undefined);
    if (!reals) return undefined;
    const [real, realDir, realTemp] = reals;
    if (path.dirname(real) !== realDir || !isInside(realTemp, realDir) || realDir === realTemp) return undefined;
    return { real, stat };
  }

  async function file(req: IncomingMessage, res: ServerResponse, name: string, query: URLSearchParams): Promise<void> {
    const found = await tempFile(name);
    if (!found) throw new HttpError(404, 'File not found', 'file.unknown');
    const { real, stat } = found;
    const headers: Record<string, string> = {};
    if (isTruthyParam(query, 'download')) headers['Content-Disposition'] = contentDisposition(name);
    sendFile(req, res, real, stat, { cacheControl: 'no-cache', sandboxActive: true, headers });
  }

  /** iOS crash report copies (SPEC §10.3: `<tempDir>/crash/<udid>/<name>.ips`), always as a download. */
  async function crashFile(req: IncomingMessage, res: ServerResponse, udid: string, name: string): Promise<void> {
    const found = await crashCopy(udid, name);
    if (!found) throw new HttpError(404, 'Crash report not found', 'file.unknown');
    const { real, stat } = found;
    sendFile(req, res, real, stat, {
      cacheControl: 'no-cache',
      contentType: 'text/plain; charset=utf-8',
      sandboxActive: true,
      headers: { 'Content-Disposition': contentDisposition(name) },
    });
  }

  async function route(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): Promise<void> {
    const segs = pathname.split('/').slice(2).filter((s, i, all) => s !== '' || i < all.length - 1).map(decodeSegment);
    const method = req.method ?? 'GET';
    const [first, second, third, fourth] = segs;
    const mod = first ? deps.modules?.find((m) => m.prefixes.includes(first)) : undefined;
    if (mod) return mod.handle(req, res, segs, query);
    switch (first) {
      case 'health':
        requireMethod(req, 'GET', 'HEAD');
        sendJson(res, 200, { ok: true, name: 'durbun', version: deps.version });
        return;
      case 'summary':
        if (segs.length !== 1) break;
        requireMethod(req, 'GET', 'HEAD');
        sendJson(res, 200, connectedSummary(deps.hub));
        return;
      case 'network': {
        if (second === 'search' && segs.length === 2 && method === 'POST') return search(req, res);
        if (!second) throw new HttpError(404, 'Not found', 'api.notFound');
        if (segs.length === 2) {
          requireMethod(req, 'GET', 'HEAD');
          return networkDetail(res, second);
        }
        if (segs.length === 3 && third === 'messages') {
          requireMethod(req, 'GET', 'HEAD');
          return streamMessages(res, second, query);
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
      case 'bug-report':
        if (segs.length !== 1) break;
        requireMethod(req, 'POST');
        return bugReport(req, res);
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
      case 'slack': {
        const slack = deps.slack;
        if (!slack) break;
        if (segs.length === 1 && method === 'PUT') return sendJson(res, 200, await slack.update(await readJson(req, SLACK_BODY_LIMIT_BYTES)));
        if (segs.length === 1) {
          requireMethod(req, 'GET', 'PUT');
          return sendJson(res, 200, await slack.status());
        }
        if (segs.length === 2 && second === 'send') {
          requireMethod(req, 'POST');
          await slack.send(await readJson(req, SLACK_BODY_LIMIT_BYTES));
          return sendJson(res, 200, { ok: true });
        }
        break;
      }
      case 'files':
        if (segs.length === 4 && second === 'crash') {
          requireMethod(req, 'GET', 'HEAD');
          return crashFile(req, res, third ?? '', fourth ?? '');
        }
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
        sendError(res, err.status, err.message, err.code, headers, err.params);
        return;
      }
      deps.logger.error(`${req.method} ${pathname} failed: ${errorMessage(err)}`);
      sendError(res, 500, `Internal error: ${errorMessage(err)}`, 'internal');
    }
  };
}
