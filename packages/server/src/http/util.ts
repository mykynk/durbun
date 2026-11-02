/** Small request/response helpers shared by the REST API and the static file server. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Writable } from 'node:stream';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Headers for every /api response: never cached, never sniffed. */
export const API_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function sendJson(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(data === undefined ? null : data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    ...API_HEADERS,
    ...headers,
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string, code?: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, code ? { error: message, code } : { error: message }, headers);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

function tooLarge(limit: number): HttpError {
  return new HttpError(413, `Request body is too large (limit ${formatBytes(limit)})`, 'body.tooLarge');
}

/** Buffer the request body, rejecting with 413 once it exceeds `limit` bytes. */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(tooLarge(limit));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (err: Error | null, value?: Buffer) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value!);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        finish(tooLarge(limit));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(null, Buffer.concat(chunks, size)));
    req.on('error', (err) => finish(err));
    req.on('close', () => {
      if (!req.complete) finish(new HttpError(400, 'Request aborted', 'body.aborted'));
    });
  });
}

/** Parse a JSON request body; an empty body yields `undefined`. */
export async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const buf = await readBody(req, limit);
  if (buf.length === 0) return undefined;
  let text: string;
  try {
    text = buf.toString('utf8');
  } catch {
    throw new HttpError(413, 'Request body is too large to decode', 'body.tooLarge');
  }
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw new HttpError(400, `Invalid JSON: ${(err as Error).message}`, 'body.invalidJson');
  }
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** `attachment; filename="…"; filename*=UTF-8''…` with a safe ASCII fallback. */
export function contentDisposition(fileName: string, disposition: 'attachment' | 'inline' = 'attachment'): string {
  const clean = fileName.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim() || 'download';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["%;]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(clean)}`;
}

/** Local time stamp for download names, e.g. 2026-11-02-114602. */
export function fileTimestamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Resolve on 'drain'; reject when the stream closes or errors first (client went away). */
export function waitForDrain(stream: Writable): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('close', onClose);
      stream.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('client closed the connection'));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    stream.on('drain', onDrain);
    stream.on('close', onClose);
    stream.on('error', onError);
  });
}

/** Write with backpressure. Throws when the client is gone. */
export async function writeChunk(stream: Writable, chunk: string | Buffer): Promise<void> {
  if (stream.destroyed || stream.writableEnded) throw new Error('client closed the connection');
  if (!stream.write(chunk)) await waitForDrain(stream);
}

/** Query parameter as a trimmed non-empty string, else undefined. */
export function queryString(params: URLSearchParams, name: string): string | undefined {
  const v = params.get(name);
  if (v === null) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

export function isTruthyParam(params: URLSearchParams, name: string): boolean {
  const v = params.get(name);
  return v !== null && v !== '0' && v.toLowerCase() !== 'false';
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}
