/**
 * Flow edits the server has not taken yet, kept in this browser's storage so a reload, a closed window or a quit
 * does not lose them. The editor offers a draft back when the flow is opened again; nothing is saved by itself
 * (another window may have changed the flow meanwhile).
 */
import type { FlowDoc } from '@durbun/protocol';
import { STORAGE_PREFIX, readStorage, removeStorage, writeStorage } from '../../../lib/persist';

const PREFIX = 'flows.draft.';
/** Drafts older than this are dropped when the list is read (the flow moved on long ago). */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 3600_000;

export interface FlowDraft {
  flow: FlowDoc;
  /** When the draft was stored (ms). */
  at: number;
  /** `updatedAt` of the server copy the edits started from (0 when unknown). */
  base: number;
}

function valid(d: unknown): d is FlowDraft {
  const x = d as FlowDraft | null;
  return !!x && typeof x === 'object' && typeof x.at === 'number' && !!x.flow && typeof x.flow === 'object' && Array.isArray(x.flow.nodes) && Array.isArray(x.flow.edges);
}

export function storeDraft(id: string, flow: FlowDoc, base: number, now = Date.now()): boolean {
  return writeStorage(PREFIX + id, { flow, at: now, base } satisfies FlowDraft);
}

export function readDraft(id: string): FlowDraft | null {
  const d = readStorage<unknown>(PREFIX + id, null);
  return valid(d) ? d : null;
}

export function dropDraft(id: string): void {
  removeStorage(PREFIX + id);
}

/** Ids of every stored draft (old ones are dropped on the way). */
export function draftIds(now = Date.now()): string[] {
  const ids: string[] = [];
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(STORAGE_PREFIX + PREFIX)) keys.push(k.slice((STORAGE_PREFIX + PREFIX).length));
    }
    for (const id of keys) {
      const d = readDraft(id);
      if (!d || now - d.at > DRAFT_MAX_AGE_MS) dropDraft(id);
      else ids.push(id);
    }
  } catch {
    /* storage unavailable: no drafts */
  }
  return ids;
}
