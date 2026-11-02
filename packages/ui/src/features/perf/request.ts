/**
 * Cross-tab navigation into the Performance view ("Performansı izle" on the Device tab). The Device view
 * imports only this tiny module; the Performance view handles the request when it is (or becomes) mounted.
 */
import { create } from 'zustand';
import { ui } from '../../data';
import type { PerfTarget } from './model';

export interface PerfRequest {
  target: PerfTarget;
  /** Start polling right away (process targets). */
  poll: boolean;
  seq: number;
}

export const usePerfRequest = create<{ req: PerfRequest | null }>()(() => ({ req: null }));

let seq = 0;

/** Switch to the Performance tab showing `target` (and start polling it when `poll`). */
export function showInPerf(target: PerfTarget, opts: { poll?: boolean } = {}): void {
  usePerfRequest.setState({ req: { target, poll: opts.poll ?? target.kind === 'process', seq: ++seq } });
  ui.setTab('perf');
}

export function consumePerfRequest(reqSeq: number): void {
  if (usePerfRequest.getState().req?.seq === reqSeq) usePerfRequest.setState({ req: null });
}
