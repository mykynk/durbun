/**
 * Pinned runs: automatic clean-up (the newest runs are kept) and "Clear history" leave them alone. The server's
 * `flows` broadcast carries no run headers, so every view that lists runs follows `usePinRevision` and reads the list
 * again after a pin changed.
 */
import { create } from 'zustand';
import type { FlowRunHeader } from '@durbun/protocol';
import { api, useFlows } from '../../../data';

export const usePinRevision = create<{ rev: number }>()(() => ({ rev: 0 }));

/** Pins or unpins a run; answers its new header. Rejects with the server's error (409 `flowRun.pinLimit` {max}). */
export async function setRunPinned(id: string, pinned: boolean): Promise<FlowRunHeader> {
  const header = await api.pinFlowRun(id, pinned);
  const now = !!header.pinned;
  // The open run (if this window holds it) shows the new state at once.
  useFlows.setState((s) => {
    const run = s.runs[id];
    if (!run || !!run.pinned === now) return s;
    const next = { ...run };
    if (now) next.pinned = true;
    else delete next.pinned;
    return { runs: { ...s.runs, [id]: next } };
  });
  usePinRevision.setState((s) => ({ rev: s.rev + 1 }));
  return header;
}
