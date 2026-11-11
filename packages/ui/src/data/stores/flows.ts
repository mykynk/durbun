import { create } from 'zustand';
import type { FlowRun, FlowRunDelta, FlowSummary } from '@durbun/protocol';

/* ───────────── Flows (Akışlar) ───────────── */

/** Finished runs kept in memory besides the running ones (older ones are read from the server on demand). */
const KEEP_FINISHED = 40;

export interface FlowsState {
  summaries: FlowSummary[];
  /** Received from the server at least once (snapshot or `flows`). */
  loaded: boolean;
  /** Runs seen live in this window, by id: steps are merged from `flowRun` deltas. */
  runs: Record<string, FlowRun>;
}

export const useFlows = create<FlowsState>()(() => ({ summaries: [], loaded: false, runs: {} }));

export function setFlowsFromServer(summaries: FlowSummary[] | undefined, running?: FlowRun[]): void {
  const runs: Record<string, FlowRun> = {};
  for (const r of running ?? []) runs[r.id] = r;
  useFlows.setState((s) => ({
    summaries: summaries ?? s.summaries,
    loaded: summaries !== undefined || s.loaded,
    // A reconnect replaces what was running; finished runs this window already saw stay readable.
    runs: { ...Object.fromEntries(Object.entries(s.runs).filter(([, r]) => r.status !== 'running')), ...runs },
  }));
}

export function setFlowSummaries(summaries: FlowSummary[]): void {
  useFlows.setState({ summaries, loaded: true });
}

/** Called once when an automatic (event-triggered) run this window watched ends as failed. */
type FailedRunListener = (run: Omit<FlowRun, 'steps'>) => void;
let onAutomaticFailure: FailedRunListener | null = (run) => {
  // The Flows tab is loaded on demand: its notice (texts, toast) comes with it.
  void import('../../features/flows/notify').then((m) => m.notifyFailedRun(run)).catch(() => undefined);
};

/** Tests replace (or silence) the notice for failed automatic runs. */
export function setAutomaticFailureListener(listener: FailedRunListener | null): void {
  onAutomaticFailure = listener;
}

/** Merges a `flowRun` delta: the header replaces, steps are merged by step id. */
export function applyFlowRunDelta(delta: FlowRunDelta): void {
  const before = useFlows.getState().runs[delta.run.id]?.status;
  const { stepCount: _n, ...head } = delta.run;
  if (head.status === 'failed' && before !== 'failed' && head.trigger?.kind === 'event') {
    try {
      onAutomaticFailure?.(head);
    } catch {
      /* a notice never breaks the store */
    }
  }
  useFlows.setState((s) => {
    const prev = s.runs[delta.run.id];
    const { stepCount: _count, ...header } = delta.run;
    let steps = prev?.steps ?? [];
    if (delta.steps.length) {
      const byId = new Map(steps.map((st) => [st.id, st]));
      for (const st of delta.steps) byId.set(st.id, st);
      steps = [...byId.values()].sort((a, b) => a.id - b.id);
    }
    const runs = { ...s.runs, [header.id]: { ...header, steps } as FlowRun };
    return { runs: prune(runs) };
  });
}

/** A run read over REST (history, a finished run this window did not see). */
export function rememberFlowRun(run: FlowRun): void {
  useFlows.setState((s) => {
    const live = s.runs[run.id];
    // A live copy that is ahead wins over a stale read: a short run can finish over the socket before the
    // answer that started it arrives, and a running copy with more steps is newer than one with fewer.
    if (live && run.status === 'running' && (live.status !== 'running' || live.steps.length >= run.steps.length)) return s;
    return { runs: prune({ ...s.runs, [run.id]: run }) };
  });
}

/** Drops the finished runs of a flow (its history was cleared); running ones stay. */
export function forgetFlowRuns(flowId: string): void {
  useFlows.setState((s) => {
    const runs = Object.fromEntries(Object.entries(s.runs).filter(([, r]) => r.flowId !== flowId || r.status === 'running'));
    const summaries = s.summaries.map((f) => (f.id === flowId && f.lastRun && f.lastRun.status !== 'running' ? (({ lastRun: _l, ...rest }) => rest)(f) : f));
    return { runs, summaries };
  });
}

function prune(runs: Record<string, FlowRun>): Record<string, FlowRun> {
  const finished = Object.values(runs).filter((r) => r.status !== 'running');
  if (finished.length <= KEEP_FINISHED) return runs;
  const drop = finished.sort((a, b) => b.startedAt - a.startedAt).slice(KEEP_FINISHED);
  const out = { ...runs };
  for (const r of drop) delete out[r.id];
  return out;
}

/** The newest run of a flow this window knows (running first). */
export function latestRunOf(runs: Record<string, FlowRun>, flowId: string): FlowRun | undefined {
  let best: FlowRun | undefined;
  for (const r of Object.values(runs)) {
    if (r.flowId !== flowId) continue;
    if (!best || (r.status === 'running') > (best.status === 'running') || ((r.status === 'running') === (best.status === 'running') && r.startedAt > best.startedAt)) best = r;
  }
  return best;
}
