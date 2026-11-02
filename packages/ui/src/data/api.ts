import type { NetworkDetail, SessionExport, ToolCheck } from '@durbun/protocol';
import { downloadBlob } from '../lib/download';

/** REST helpers for `/api/*` (same origin; Vite proxies `/api` in dev). */

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`.trim();
  let code: string | undefined;
  try {
    const text = await res.text();
    if (text) {
      try {
        const body = JSON.parse(text) as { error?: unknown; message?: unknown; code?: unknown };
        const m = body.error ?? body.message;
        if (typeof m === 'string' && m) message = m;
        if (typeof body.code === 'string') code = body.code;
      } catch {
        message = text.slice(0, 300);
      }
    }
  } catch {
    /* ignore */
  }
  return new ApiError(res.status, message, code);
}

async function fetchOk(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    throw new ApiError(0, err instanceof Error ? err.message : 'Network error', 'network');
  }
  if (!res.ok) throw await errorFrom(res);
  return res;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchOk(path, init);
  return (await res.json()) as T;
}

function postJson(body: unknown, signal?: AbortSignal): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal };
}

const enc = encodeURIComponent;

export function health(signal?: AbortSignal): Promise<{ ok: boolean; name: string; version: string }> {
  return json('/api/health', { signal });
}

/** Full network entry with bodies (`GET /api/network/:id`). */
export function getNetworkDetail(id: string, signal?: AbortSignal): Promise<NetworkDetail> {
  return json(`/api/network/${enc(id)}`, { signal });
}

/** URL of a raw body (original Content-Type). `download` adds Content-Disposition. */
export function bodyUrl(id: string, which: 'request' | 'response', opts: { download?: boolean } = {}): string {
  return `/api/network/${enc(id)}/body/${which}${opts.download ? '?download=1' : ''}`;
}

/** Server-side search over URLs, headers and bodies. Resolves with matching network ids. */
export async function searchNetwork(
  text: string,
  opts: { ids?: string[]; caseSensitive?: boolean; signal?: AbortSignal } = {},
): Promise<string[]> {
  const res = await json<{ ids?: string[] }>(
    '/api/network/search',
    postJson({ text, ids: opts.ids, caseSensitive: opts.caseSensitive }, opts.signal),
  );
  return Array.isArray(res.ids) ? res.ids : [];
}

/** Session export download URL (`durbun-<date>.durbun.json`), optionally limited to a device/app. */
export function exportUrl(scope: { deviceId?: string; appId?: string } = {}): string {
  const q = new URLSearchParams();
  if (scope.deviceId) q.set('deviceId', scope.deviceId);
  if (scope.appId) q.set('appId', scope.appId);
  const qs = q.toString();
  return `/api/export${qs ? `?${qs}` : ''}`;
}

export interface ImportOptions {
  /** File name of the session (`?name=`): the server labels the imported devices with it. A `File`'s own name is used when omitted. */
  name?: string;
  signal?: AbortSignal;
}

/** `/api/import` URL with the `?name=` label (file name), when there is one. */
export function importUrl(name?: string): string {
  const label = name?.trim();
  return label ? `/api/import?name=${enc(label)}` : '/api/import';
}

/**
 * Import a session export (file, blob, parsed object or JSON text). Resolves with the new device ids.
 * The second argument is an `AbortSignal` or `{ name?, signal? }`; files send their own name.
 */
export async function importSession(
  input: File | Blob | SessionExport | string,
  options?: AbortSignal | ImportOptions,
): Promise<{ deviceIds: string[] }> {
  const opts: ImportOptions = isAbortSignal(options) ? { signal: options } : (options ?? {});
  const name = opts.name ?? (typeof File !== 'undefined' && input instanceof File ? input.name : undefined);
  const body: BodyInit = typeof input === 'string' || input instanceof Blob ? input : JSON.stringify(input);
  const res = await json<{ deviceIds?: string[] }>(importUrl(name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: opts.signal,
  });
  return { deviceIds: Array.isArray(res.deviceIds) ? res.deviceIds : [] };
}

function isAbortSignal(v: unknown): v is AbortSignal {
  return typeof AbortSignal !== 'undefined' && v instanceof AbortSignal;
}

/** HAR 1.2 for the given network ids (all when omitted). */
export async function harExport(ids?: string[], signal?: AbortSignal): Promise<Blob> {
  const res = await fetchOk('/api/har', postJson({ ids }, signal));
  return res.blob();
}

/** Fetch a HAR and save it as a file. */
export async function downloadHar(ids?: string[], filename?: string): Promise<void> {
  const blob = await harExport(ids);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadBlob(blob, filename ?? `durbun-${stamp}.har`);
}

/** Environment checks (`GET /api/doctor`). */
export function doctor(signal?: AbortSignal): Promise<ToolCheck[]> {
  return json('/api/doctor', { signal });
}

/** URL of a file saved by the server (screenshots, recordings). */
export function fileUrl(name: string): string {
  return `/api/files/${enc(name)}`;
}

export interface UploadOptions {
  name?: string;
  onProgress?: (loaded: number, total: number) => void;
  signal?: AbortSignal;
}

/** Stream a file to the server (`POST /api/upload`); resolves with the server path for `app-install`. */
export function upload(file: File | Blob, opts: UploadOptions = {}): Promise<{ file: string }> {
  const name = opts.name ?? (file instanceof File ? file.name : 'upload.bin');
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?name=${enc(name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) opts.onProgress?.(ev.loaded, ev.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText) as { file?: string };
          if (typeof body.file === 'string') resolve({ file: body.file });
          else reject(new ApiError(xhr.status, 'Malformed upload response'));
        } catch {
          reject(new ApiError(xhr.status, 'Malformed upload response'));
        }
      } else {
        let message = `${xhr.status} ${xhr.statusText}`.trim();
        let code: string | undefined;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: unknown; code?: unknown };
          if (typeof body.error === 'string' && body.error) message = body.error;
          if (typeof body.code === 'string') code = body.code;
        } catch {
          /* ignore */
        }
        reject(new ApiError(xhr.status, message, code));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed', 'network'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (opts.signal) {
      if (opts.signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
}
