import type { FlowRunHeader, FlowSummary } from '@durbun/protocol';

/**
 * The picked flows plus every flow they call, directly or deeper (`FlowSummary.calls`). The server puts the same
 * set into a share package (`withCalledFlows`), so the runs that travel with it are the runs of these flows.
 */
export function flowsWithCalls(summaries: readonly Pick<FlowSummary, 'id' | 'calls'>[], picked: Iterable<string>): Set<string> {
  const byId = new Map(summaries.map((f) => [f.id, f]));
  const out = new Set<string>();
  const stack = [...picked];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    const f = byId.get(id);
    if (!f) continue;
    out.add(id);
    for (const c of f.calls ?? []) stack.push(c);
  }
  return out;
}

/** Finished runs of these flows (a run still going is never packed), newest first as listed. */
export function runsOfFlows(headers: readonly FlowRunHeader[], flowIds: ReadonlySet<string>): FlowRunHeader[] {
  return headers.filter((h) => h.status !== 'running' && flowIds.has(h.flowId));
}

/** How many flows these runs come from. */
export function flowCountOf(runs: readonly Pick<FlowRunHeader, 'flowId'>[]): number {
  return new Set(runs.map((r) => r.flowId)).size;
}
