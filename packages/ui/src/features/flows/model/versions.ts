/** Flow versions in words: what a save changed, why a version was kept. */
import type { FlowVersionChanges, FlowVersionReason } from '@durbun/protocol';

type T = (key: string, params?: Record<string, string | number>) => string;

/** "2 steps added · 1 step changed · renamed from “Login”", or '' when nothing worth saying changed. */
export function changesText(c: FlowVersionChanges | undefined, t: T): string {
  if (!c) return '';
  const parts: string[] = [];
  if (c.renamedFrom) parts.push(t('flows.versions.change.renamed', { name: c.renamedFrom }));
  if (c.stepsAdded) parts.push(t('flows.versions.change.added', { count: c.stepsAdded }));
  if (c.stepsRemoved) parts.push(t('flows.versions.change.removed', { count: c.stepsRemoved }));
  if (c.stepsChanged) parts.push(t('flows.versions.change.changed', { count: c.stepsChanged }));
  if (c.connections) parts.push(t('flows.versions.change.connections', { count: c.connections }));
  if (c.settings) parts.push(t('flows.versions.change.settings'));
  // Moving steps around is worth a word only when nothing else changed.
  if (!parts.length && c.stepsMoved) parts.push(t('flows.versions.change.moved', { count: c.stepsMoved }));
  return parts.join(' · ');
}

/** What replaced a version, when it was not an ordinary edit. */
export function replacedByKey(reason: FlowVersionReason): string | null {
  return reason === 'restore' ? 'flows.versions.reason.restore' : reason === 'import' ? 'flows.versions.reason.import' : null;
}
