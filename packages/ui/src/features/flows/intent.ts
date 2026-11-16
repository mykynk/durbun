/**
 * Requests for the Flows tab from outside it (the command palette works before the tab was ever opened, so the
 * Flows view may not be mounted yet). Small on purpose: the shell imports it without loading the editor.
 */
import { create } from 'zustand';
import { ui } from '../../data';

export type FlowIntent =
  | { kind: 'new' }
  | { kind: 'requests' }
  | { kind: 'ai' }
  | { kind: 'import' }
  | { kind: 'environments' }
  /** Open this flow and run it (the run still goes through the usual checks). */
  | { kind: 'run'; flowId: string };

export const useFlowIntent = create<{ intent: FlowIntent | null; seq: number }>()(() => ({ intent: null, seq: 0 }));

export function requestFlowIntent(intent: FlowIntent): void {
  useFlowIntent.setState((s) => ({ intent, seq: s.seq + 1 }));
  ui.setTab('flows');
}

/** The Flows view takes the request once it acted on it. */
export function takeFlowIntent(seq: number): FlowIntent | null {
  const s = useFlowIntent.getState();
  if (s.seq !== seq || !s.intent) return null;
  useFlowIntent.setState({ intent: null });
  return s.intent;
}
