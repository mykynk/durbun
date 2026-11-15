/**
 * POST /api/bug-report (protocol bugReport.ts): the report the UI wrote, its log lines, the requests as a HAR,
 * the screenshot, the iOS crash report and a Dürbün recording of the window, as one .zip a tracker accepts.
 * Parts that are gone (a screenshot the temp-dir cleanup removed) are left out and named in X-Durbun-Skipped.
 */
import { inflateRawSync } from 'node:zlib';
import {
  BUG_REPORT_MAX_LOG_LINES,
  BUG_REPORT_MAX_REQUESTS,
  BUG_REPORT_MAX_WINDOW_MS,
  type BugReportRequest,
  type SessionExport,
} from '@durbun/protocol';
import { isPlainObject } from '../config';
import { createZip, readZip, type ZipFile } from '../util/zip';
import { HttpError } from './util';

/** Report text and log text are each at most this large (a capped window of lines is far smaller). */
const MAX_TEXT_CHARS = 8 * 1024 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const invalid = (message: string) => new HttpError(400, message, 'bugReport.invalid');

const optionalString = (v: unknown, what: string): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw invalid(`${what} must be a string`);
  return v;
};

/** Validates the body. The window is cut to BUG_REPORT_MAX_WINDOW_MS (its end kept: the moment is there). */
export function parseBugReportRequest(body: unknown): BugReportRequest {
  if (!isPlainObject(body)) throw invalid('Expected a bug report object');
  if (typeof body.report !== 'string' || !body.report.trim()) throw invalid('report must be a non-empty string');
  if (body.report.length > MAX_TEXT_CHARS) throw invalid('The report is too long');
  const out: BugReportRequest = { report: body.report };
  const logs = optionalString(body.logs, 'logs');
  if (logs !== undefined) {
    if (logs.length > MAX_TEXT_CHARS) throw invalid('The log text is too long');
    out.logs = logs;
  }
  if (body.requestIds !== undefined && body.requestIds !== null) {
    if (!Array.isArray(body.requestIds) || body.requestIds.some((x) => typeof x !== 'string')) throw invalid('requestIds must be a list of strings');
    out.requestIds = (body.requestIds as string[]).slice(-BUG_REPORT_MAX_REQUESTS);
  }
  const screenshot = optionalString(body.screenshot, 'screenshot');
  if (screenshot) out.screenshot = screenshot;
  const crashReport = optionalString(body.crashReport, 'crashReport');
  if (crashReport) out.crashReport = crashReport;
  if (body.recording !== undefined && body.recording !== null) {
    const r = body.recording;
    if (!isPlainObject(r) || typeof r.fromTs !== 'number' || typeof r.toTs !== 'number' || !Number.isFinite(r.fromTs) || !Number.isFinite(r.toTs) || r.toTs < r.fromTs) {
      throw invalid('recording needs fromTs <= toTs (epoch ms)');
    }
    const deviceId = optionalString(r.deviceId, 'recording.deviceId');
    const appId = optionalString(r.appId, 'recording.appId');
    const bundleId = optionalString(r.bundleId, 'recording.bundleId');
    if (bundleId && !deviceId) throw new HttpError(400, 'bundleId needs deviceId (the device the app is on)', 'export.bundleNeedsDevice');
    if (bundleId && appId) throw new HttpError(400, 'Give either appId or bundleId, not both', 'export.scopeConflict');
    out.recording = {
      ...(deviceId ? { deviceId } : {}),
      ...(appId ? { appId } : {}),
      ...(bundleId ? { bundleId } : {}),
      fromTs: Math.max(r.fromTs, r.toTs - BUG_REPORT_MAX_WINDOW_MS),
      toTs: r.toTs,
    };
  }
  if (body.mask !== undefined && body.mask !== null) {
    if (typeof body.mask !== 'boolean') throw invalid('mask must be true or false');
    out.mask = body.mask;
  }
  const name = optionalString(body.name, 'name');
  if (name) {
    if (!NAME.test(name)) throw invalid('name may hold letters, digits, ".", "-" and "_"');
    out.name = name;
  }
  return out;
}

/**
 * The part of a recording inside [fromTs, toTs]: log lines by time, requests that started in it, metric samples
 * in it. Devices, apps and device apps stay (the lines name them).
 */
export function sliceSessionExport(data: SessionExport, fromTs: number, toTs: number): SessionExport {
  const inside = (ts: number) => ts >= fromTs && ts <= toTs;
  return {
    ...data,
    logs: data.logs.filter((e) => inside(e.ts)).slice(-BUG_REPORT_MAX_LOG_LINES * 2),
    network: data.network.filter((n) => inside(n.startTs)).slice(-BUG_REPORT_MAX_REQUESTS),
    ...(data.metrics ? { metrics: data.metrics.filter((m) => inside(m.ts)) } : {}),
  };
}

/** `/api/files/<name>` (or a bare name) → the file name in the temp dir. */
export function tempFileName(urlOrName: string): string {
  const raw = urlOrName.startsWith('/api/files/') ? urlOrName.slice('/api/files/'.length) : urlOrName;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** `/api/files/crash/<udid>/<name>` → its parts; undefined for anything else. */
export function crashFileParts(url: string): { udid: string; name: string } | undefined {
  const m = /^\/api\/files\/crash\/([^/]+)\/([^/]+)$/.exec(url);
  if (!m) return undefined;
  try {
    return { udid: decodeURIComponent(m[1]!), name: decodeURIComponent(m[2]!) };
  } catch {
    return undefined;
  }
}

export interface BugReportParts {
  report: string;
  logs?: string;
  har?: unknown;
  screenshot?: { name: string; data: Buffer };
  crashReport?: { name: string; data: Buffer };
  recording?: SessionExport;
}

/** The archive: report.md first (what a tracker previews), then the evidence. */
export function bugReportZip(parts: BugReportParts, now = Date.now()): Buffer {
  const files: ZipFile[] = [{ name: 'report.md', data: Buffer.from(parts.report, 'utf8') }];
  if (parts.logs) files.push({ name: 'logs.txt', data: Buffer.from(parts.logs, 'utf8') });
  if (parts.har) files.push({ name: 'requests.har', data: Buffer.from(JSON.stringify(parts.har, null, 2), 'utf8') });
  if (parts.screenshot) {
    const ext = /\.(png|jpe?g|heic|webp)$/i.exec(parts.screenshot.name)?.[0]?.toLowerCase() ?? '.png';
    files.push({ name: `screenshot${ext}`, data: parts.screenshot.data, store: true });
  }
  if (parts.crashReport) files.push({ name: `crash/${parts.crashReport.name}`, data: parts.crashReport.data });
  if (parts.recording) files.push({ name: 'recording.durbun.json', data: Buffer.from(JSON.stringify(parts.recording, null, 2), 'utf8') });
  return createZip(files, now);
}

/** Lists an archive's entries (tests). */
export function readBugReportZip(zip: Buffer): { name: string; data: Buffer }[] {
  return readZip(zip, (b) => inflateRawSync(b));
}
