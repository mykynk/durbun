/**
 * REST calls of set runs, flow versions and deleted flows (SPEC §11.3). Same origin, relative URLs, and the same
 * `ApiError` the data layer throws (status, server `code`, parsed body), so `errorText` / `flowErrorText` word them.
 */
import type { FlowBatch, FlowBatchRequest, FlowDoc, FlowHistory, FlowIssue, FlowTrashItem } from '@durbun/protocol';
import { ApiError } from '../../../data';

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    throw new ApiError(0, err instanceof Error ? err.message : 'Network error', 'network');
  }
  const text = await res.text().catch(() => '');
  let body: Record<string, unknown> | undefined;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const message = typeof body?.error === 'string' ? body.error : text.slice(0, 300) || `${res.status} ${res.statusText}`.trim();
    throw new ApiError(res.status, message, typeof body?.code === 'string' ? body.code : undefined, body);
  }
  return body as T;
}

const post = (body?: unknown, signal?: AbortSignal): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}), signal });
const enc = encodeURIComponent;

export interface FlowWithIssues {
  flow: FlowDoc;
  issues: FlowIssue[];
}

/* ── set runs ── */

export function startBatch(req: FlowBatchRequest): Promise<FlowBatch> {
  return call('/api/flow-batches', post(req));
}

export function listBatches(limit = 20, signal?: AbortSignal): Promise<{ running?: FlowBatch; batches: FlowBatch[] }> {
  return call(`/api/flow-batches?limit=${limit}`, { signal });
}

export function getBatch(id: string, signal?: AbortSignal): Promise<FlowBatch> {
  return call(`/api/flow-batches/${enc(id)}`, { signal });
}

export async function cancelBatch(id: string): Promise<void> {
  await call(`/api/flow-batches/${enc(id)}/cancel`, post());
}

export async function deleteBatch(id: string): Promise<void> {
  await call(`/api/flow-batches/${enc(id)}`, { method: 'DELETE' });
}

/* ── versions ── */

export function flowHistory(flowId: string, signal?: AbortSignal): Promise<FlowHistory> {
  return call(`/api/flows/${enc(flowId)}/history`, { signal });
}

/** Puts a version back; `versionId` is the content it replaced, kept as a version (restoring it undoes this). */
export function restoreVersion(flowId: string, versionId: string, opts: { baseUpdatedAt?: number } = {}): Promise<FlowWithIssues & { versionId?: string }> {
  return call(`/api/flows/${enc(flowId)}/history/${enc(versionId)}/restore`, post(opts.baseUpdatedAt !== undefined ? { baseUpdatedAt: opts.baseUpdatedAt } : {}));
}

/* ── deleted flows ── */

/** Deletes a flow; the server keeps it in the trash (`trash` says until when). */
export async function deleteFlowToTrash(flowId: string): Promise<FlowTrashItem | undefined> {
  const r = await call<{ ok: boolean; trash?: FlowTrashItem } | undefined>(`/api/flows/${enc(flowId)}`, { method: 'DELETE' });
  return r?.trash;
}

export function listTrash(signal?: AbortSignal): Promise<{ items: FlowTrashItem[]; keepDays: number }> {
  return call('/api/flow-trash', { signal });
}

export function restoreTrashed(trashId: string): Promise<FlowWithIssues> {
  return call(`/api/flow-trash/${enc(trashId)}/restore`, post());
}

export async function purgeTrashed(trashId: string): Promise<void> {
  await call(`/api/flow-trash/${enc(trashId)}`, { method: 'DELETE' });
}
