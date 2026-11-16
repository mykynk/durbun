/**
 * Every flow that starts on its own, in one place: switch one off, or pause them all at once and bring the same set
 * back later. The switch is the flow's own `automation.enabled` (saved through the flows API), so a paused flow also
 * stays off in other windows; the set to bring back is remembered on this Mac.
 */
import { create } from 'zustand';
import type { FlowDoc, FlowSummary } from '@durbun/protocol';
import { api, isEditConflict } from '../../../data';
import { readStorage, removeStorage, writeStorage } from '../../../lib/persist';

const PAUSED_KEY = 'flows.pausedAutomations';

/** Flows that would start on their own right now. */
export function automatedFlows(summaries: readonly FlowSummary[]): FlowSummary[] {
  return summaries.filter((f) => f.automation && f.triggers.includes('event')).sort((a, b) => a.name.localeCompare(b.name));
}

function readPaused(): string[] {
  const v = readStorage<unknown>(PAUSED_KEY, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Flows switched off by "Pause all", for "Resume". */
export const usePausedAutomations = create<{ ids: string[] }>()(() => ({ ids: readPaused() }));

function setPaused(ids: string[]): void {
  if (ids.length) writeStorage(PAUSED_KEY, ids);
  else removeStorage(PAUSED_KEY);
  usePausedAutomations.setState({ ids });
}

/** Paused flows that still exist and can still start on their own once switched back on. */
export function resumable(paused: readonly string[], summaries: readonly FlowSummary[]): FlowSummary[] {
  const byId = new Map(summaries.map((f) => [f.id, f]));
  return paused.map((id) => byId.get(id)).filter((f): f is FlowSummary => !!f && !f.automation && f.triggers.includes('event'));
}

function withAutomation(flow: FlowDoc, enabled: boolean): FlowDoc {
  return { ...flow, automation: { ...(flow.automation ?? {}), enabled } };
}

/**
 * Switches one flow's automation. Reads the latest copy first and saves against it, so an edit saved in the
 * meantime is kept (one retry when the flow changed between the two calls).
 */
export async function setAutomation(id: string, enabled: boolean): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const { flow } = await api.getFlow(id);
    if (!!flow.automation?.enabled === enabled) return;
    try {
      await api.saveFlow(id, withAutomation(flow, enabled), { baseUpdatedAt: flow.updatedAt });
      return;
    } catch (err) {
      if (attempt === 0 && isEditConflict(err)) continue;
      throw err;
    }
  }
}

export interface BulkResult {
  done: string[];
  failed: { id: string; error: unknown }[];
}

async function each(ids: readonly string[], enabled: boolean): Promise<BulkResult> {
  const out: BulkResult = { done: [], failed: [] };
  for (const id of ids) {
    try {
      await setAutomation(id, enabled);
      out.done.push(id);
    } catch (error) {
      out.failed.push({ id, error });
    }
  }
  return out;
}

/** Switches every given flow off and remembers them (added to an earlier pause that was not resumed). */
export async function pauseAutomations(ids: readonly string[]): Promise<BulkResult> {
  const res = await each(ids, false);
  setPaused([...new Set([...usePausedAutomations.getState().ids, ...res.done])]);
  return res;
}

/**
 * Switches the paused flows back on. Only the ones that failed stay in the paused set; flows that were deleted or
 * switched on by hand in the meantime are forgotten.
 */
export async function resumeAutomations(ids: readonly string[]): Promise<BulkResult> {
  const res = await each(ids, true);
  setPaused(res.failed.map((f) => f.id));
  return res;
}

/** Forget the paused set (the flows stay off). */
export function forgetPaused(): void {
  setPaused([]);
}
