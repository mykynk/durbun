import type {
  BackupSettings,
  BackupSettingsPatch,
  FlowDoc,
  FlowEnvironments,
  FlowIssue,
  FlowPreflight,
  FlowRun,
  FlowRunHeader,
  FlowRunRequest,
  FlowSummary,
  NetworkDetail,
  PackageConflict,
  PackageExportRequest,
  PackageImportRequest,
  PackageImportResult,
  PackageManifest,
  SessionExport,
  ToolCheck,
} from '@durbun/protocol';
import { downloadBlob } from '../lib/download';

/** REST helpers for `/api/*` (same origin; Vite proxies `/api` in dev). */

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  /** The parsed JSON error body (e.g. `{ error, code, preflight }` of a flow that cannot start). */
  readonly body?: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, body?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`.trim();
  let code: string | undefined;
  let parsed: Record<string, unknown> | undefined;
  try {
    const text = await res.text();
    if (text) {
      try {
        const body = JSON.parse(text) as { error?: unknown; message?: unknown; code?: unknown };
        const m = body.error ?? body.message;
        if (typeof m === 'string' && m) message = m;
        if (typeof body.code === 'string') code = body.code;
        if (body && typeof body === 'object') parsed = body as Record<string, unknown>;
      } catch {
        message = text.slice(0, 300);
      }
    }
  } catch {
    /* ignore */
  }
  return new ApiError(res.status, message, code, parsed);
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

/**
 * Session export download URL (`durbun-<date>.durbun.json`), optionally limited to a device, an app session
 * (`appId`) or one app the device reports (`deviceId` + `bundleId`: that app's lines, sessions, requests and
 * DeviceApp only — an SDK-less app has no session id).
 */
export function exportUrl(scope: { deviceId?: string; appId?: string; bundleId?: string } = {}): string {
  const q = new URLSearchParams();
  if (scope.deviceId) q.set('deviceId', scope.deviceId);
  if (scope.appId) q.set('appId', scope.appId);
  if (scope.bundleId && scope.deviceId) q.set('bundleId', scope.bundleId);
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

/** Send to Slack (`/api/slack`): whether a webhook is set; the server never sends the URL itself back. */
export interface SlackStatus {
  configured: boolean;
  /** "hooks.slack.com · …wxyz" */
  hint?: string;
  sender?: string;
}

export function slackStatus(signal?: AbortSignal): Promise<SlackStatus> {
  return json('/api/slack', { signal });
}

/** `webhookUrl: null` disconnects, `sender: null` clears the name; a missing key keeps the value. */
export function updateSlack(patch: { webhookUrl?: string | null; sender?: string | null }): Promise<SlackStatus> {
  return json('/api/slack', { ...postJson(patch), method: 'PUT' });
}

/** Posts Slack mrkdwn text (`toSlackText`) to the connected channel. */
export async function sendToSlack(text: string, signal?: AbortSignal): Promise<void> {
  await fetchOk('/api/slack/send', postJson({ text }, signal));
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

/* ───────────── Flows (Akışlar) ───────────── */

export interface FlowWithIssues {
  flow: FlowDoc;
  issues: FlowIssue[];
}

export function listFlows(signal?: AbortSignal): Promise<FlowSummary[]> {
  return json('/api/flows', { signal });
}

export function getFlow(id: string, signal?: AbortSignal): Promise<FlowWithIssues> {
  return json(`/api/flows/${enc(id)}`, { signal });
}

/** A new flow (the server picks a free id from the name when the id is taken). */
export function createFlow(flow: unknown): Promise<FlowWithIssues> {
  return json('/api/flows', postJson({ flow }));
}

/** Saves a flow; drafts with errors are saved too and come back with their issues. */
export function saveFlow(id: string, flow: unknown): Promise<FlowWithIssues> {
  return json(`/api/flows/${enc(id)}`, { ...postJson({ flow }), method: 'PUT' });
}

export async function deleteFlow(id: string): Promise<void> {
  await fetchOk(`/api/flows/${enc(id)}`, { method: 'DELETE' });
}

export function duplicateFlow(id: string, name?: string): Promise<FlowWithIssues> {
  return json(`/api/flows/${enc(id)}/duplicate`, postJson({ name }));
}

/** Download URL of one flow file (`<id>.durbun-flow.json`). */
export function flowExportUrl(id: string): string {
  return `/api/flows/${enc(id)}/export`;
}

/** Download URL of the flow JSON Schema. */
export function flowSchemaUrl(): string {
  return '/api/flows/schema?download=1';
}

export interface AiPackRequest {
  goal?: string;
  flowId?: string;
  appId?: string;
  deviceId?: string;
  include?: { schema?: boolean; requests?: boolean; flows?: boolean; environments?: boolean };
  language?: 'tr' | 'en';
}

/** The Markdown the user hands to their own AI (Dürbün never calls one). */
export function aiPack(req: AiPackRequest, signal?: AbortSignal): Promise<{ markdown: string }> {
  return json('/api/flows/ai-pack', postJson(req, signal));
}

export interface FlowImportItem {
  flow: FlowDoc;
  issues: FlowIssue[];
  exists: boolean;
  differs: boolean;
  nodes: number;
}

/** Reads flows out of any text (an AI answer, a flow file, a package) and validates them. Nothing is saved. */
export function previewFlowImport(text: string, signal?: AbortSignal): Promise<{ items: FlowImportItem[]; problems: string[] }> {
  return json('/api/flows/import/preview', postJson({ text }, signal));
}

export function importFlows(
  flows: FlowDoc[],
  conflict: PackageConflict,
): Promise<{ saved: { id: string; name: string; created: boolean }[]; skipped: number; problems: string[] }> {
  return json('/api/flows/import', postJson({ flows, conflict }));
}

export interface FromRequestsResult extends FlowWithIssues {
  envVars: { key: string; secret?: boolean }[];
  links: number;
}

/** A new flow from captured requests (in the order they happened); base URL and secrets go to the environment. */
export function flowFromRequests(ids: string[], name: string, opts: { saveEnv?: boolean; environmentId?: string } = {}): Promise<FromRequestsResult> {
  return json('/api/flows/from-requests', postJson({ ids, name, ...opts }));
}

export function preflightFlow(id: string, req: FlowRunRequest, signal?: AbortSignal): Promise<FlowPreflight> {
  return json(`/api/flows/${enc(id)}/preflight`, postJson(req, signal));
}

/** Starts a run. A flow that cannot start throws an ApiError whose `body.preflight` says why. */
export function runFlow(id: string, req: FlowRunRequest): Promise<FlowRun> {
  return json(`/api/flows/${enc(id)}/run`, postJson(req));
}

export function listFlowRuns(opts: { flowId?: string; limit?: number; signal?: AbortSignal } = {}): Promise<{ running: FlowRunHeader[]; runs: FlowRunHeader[] }> {
  const q = new URLSearchParams();
  if (opts.flowId) q.set('flowId', opts.flowId);
  if (opts.limit) q.set('limit', String(opts.limit));
  const qs = q.toString();
  return json(`/api/flow-runs${qs ? `?${qs}` : ''}`, { signal: opts.signal });
}

export function getFlowRun(id: string, signal?: AbortSignal): Promise<FlowRun> {
  return json(`/api/flow-runs/${enc(id)}`, { signal });
}

export async function deleteFlowRun(id: string): Promise<void> {
  await fetchOk(`/api/flow-runs/${enc(id)}`, { method: 'DELETE' });
}

export async function clearFlowRuns(flowId?: string): Promise<number> {
  const res = await json<{ removed?: number }>(`/api/flow-runs${flowId ? `?flowId=${enc(flowId)}` : ''}`, { method: 'DELETE' });
  return typeof res.removed === 'number' ? res.removed : 0;
}

export async function cancelFlowRun(id: string): Promise<void> {
  await fetchOk(`/api/flow-runs/${enc(id)}/cancel`, { method: 'POST' });
}

export function getFlowEnvironments(signal?: AbortSignal): Promise<FlowEnvironments> {
  return json('/api/flow-environments', { signal });
}

export function saveFlowEnvironments(envs: FlowEnvironments): Promise<FlowEnvironments> {
  return json('/api/flow-environments', { ...postJson(envs), method: 'PUT' });
}

/* ───────────── Dürbün packages, backups, UI preferences ───────────── */

function fileNameOf(res: Response, fallback: string): string {
  const cd = res.headers.get('Content-Disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain?.[1] ?? fallback;
}

/** Builds a `.durbun` package; resolves with the file to save. */
export async function exportPackage(req: PackageExportRequest): Promise<{ blob: Blob; fileName: string }> {
  const res = await fetchOk('/api/packages/export', postJson(req));
  const blob = await res.blob();
  return { blob, fileName: fileNameOf(res, `Durbun-${req.kind}.durbun`) };
}

/**
 * What a package holds. `text` is the file content as is (it is not parsed and re-encoded here: packages with run
 * evidence can be large). The manifest's `token` imports it without sending it again.
 */
export function inspectPackage(text: string, passphrase?: string, signal?: AbortSignal): Promise<PackageManifest> {
  // A byte order mark (some editors write one) would break the wrapping below.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const body = `{"package":${clean}${passphrase ? `,"passphrase":${JSON.stringify(passphrase)}` : ''}}`;
  return json('/api/packages/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal });
}

/** Reads the package an earlier inspect kept again (by its token), e.g. to check a passphrase, without sending it. */
export function inspectStagedPackage(token: string, passphrase?: string, signal?: AbortSignal): Promise<PackageManifest> {
  return json('/api/packages/inspect', postJson({ token, ...(passphrase ? { passphrase } : {}) }, signal));
}

/** The import dialog closed: the server forgets the package it kept for it. */
export async function releasePackage(token: string): Promise<void> {
  await fetchOk('/api/packages/release', postJson({ token }));
}

export function importPackage(req: PackageImportRequest): Promise<PackageImportResult> {
  return json('/api/packages/import', postJson(req));
}

export function getBackup(signal?: AbortSignal): Promise<BackupSettings> {
  return json('/api/backup', { signal });
}

export function updateBackup(patch: BackupSettingsPatch): Promise<BackupSettings> {
  return json('/api/backup', { ...postJson(patch), method: 'PUT' });
}

export function runBackup(): Promise<{ file: string; size: number; settings: BackupSettings }> {
  return json('/api/backup/run', { method: 'POST' });
}

export interface BackupFolderSuggestion {
  id: string;
  label: string;
  path: string;
}

export function backupSuggestions(signal?: AbortSignal): Promise<BackupFolderSuggestion[]> {
  return json('/api/backup/suggestions', { signal });
}

export interface BackupFile {
  file: string;
  name: string;
  size: number;
  modifiedAt: number;
}

export function backupFiles(signal?: AbortSignal): Promise<BackupFile[]> {
  return json('/api/backup/files', { signal });
}

/** One backup file of the folder, as text (inspect it like a package the user picked). */
export async function readBackupFile(name: string, signal?: AbortSignal): Promise<string> {
  const res = await fetchOk(`/api/backup/files/${enc(name)}`, { signal });
  return res.text();
}

/** The UI's preferences the server keeps for backups and packages. */
export function getUiPrefs(signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  return json('/api/ui-prefs', { signal });
}

export async function putUiPrefs(prefs: Record<string, unknown>): Promise<void> {
  await fetchOk('/api/ui-prefs', { ...postJson(prefs), method: 'PUT' });
}
