/**
 * Set runs in this window: the one running now (any window may have started it), the recent ones and every set
 * read so far. The server has no live message for sets: while one runs it is read every second; otherwise a run that
 * belongs to a set (WS `flowRun` with `batchId`) is what tells this window a set started elsewhere.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import type { FlowBatch } from '@durbun/protocol';
import { useFlows } from '../../../data';
import { getBatch, listBatches } from './setsApi';

const POLL_MS = 1_000;

interface SetsState {
  running: FlowBatch | null;
  /** Newest first; null until read. */
  recent: FlowBatch[] | null;
  byId: Record<string, FlowBatch>;
}

export const useSets = create<SetsState>()(() => ({ running: null, recent: null, byId: {} }));

/** Keeps a set read from the server (a newer copy of the same set wins). */
export function rememberSet(b: FlowBatch): void {
  useSets.setState((s) => {
    const recent = s.recent ? [b, ...s.recent.filter((x) => x.id !== b.id)].sort((x, y) => y.startedAt - x.startedAt) : s.recent;
    const running = b.status === 'running' ? b : s.running?.id === b.id ? null : s.running;
    return { byId: { ...s.byId, [b.id]: b }, recent, running };
  });
}

export function forgetSet(id: string): void {
  useSets.setState((s) => {
    const { [id]: _gone, ...byId } = s.byId;
    return { byId, recent: s.recent?.filter((b) => b.id !== id) ?? null, running: s.running?.id === id ? null : s.running };
  });
}

let reading: Promise<void> | null = null;

/** Reads the running set and the recent ones. */
export function refreshSets(): Promise<void> {
  reading ??= listBatches(20)
    .then(
      (r) => {
        const byId = { ...useSets.getState().byId };
        for (const b of r.batches) byId[b.id] = b;
        if (r.running) byId[r.running.id] = r.running;
        useSets.setState({ running: r.running ?? null, recent: r.batches, byId });
      },
      () => undefined,
    )
    .finally(() => {
      reading = null;
    });
  return reading;
}

export async function refreshSet(id: string): Promise<FlowBatch | undefined> {
  try {
    const b = await getBatch(id);
    rememberSet(b);
    return b;
  } catch {
    return undefined;
  }
}

/** Follows the sets while the Flows tab is on screen. */
export function useSetsSync(active: boolean): void {
  const runningId = useSets((s) => s.running?.id ?? null);
  // A run of a set this window does not know about (started in another window).
  const foreign = useFlows((s) => {
    for (const r of Object.values(s.runs)) if (r.status === 'running' && r.batchId && r.batchId !== runningId) return r.batchId;
    return null;
  });
  useEffect(() => {
    if (active) void refreshSets();
  }, [active, foreign]);
  useEffect(() => {
    if (!active || !runningId) return;
    const timer = setInterval(() => {
      void refreshSet(runningId).then((b) => {
        // Ended: the list of recent sets shows its final counts.
        if (b && b.status !== 'running') void refreshSets();
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, runningId]);
}
