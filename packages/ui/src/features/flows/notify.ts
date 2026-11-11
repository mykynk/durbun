/**
 * The notice for an automatic (event-triggered) run that failed: nobody started it, so nobody is looking at it.
 * Loaded on demand by the flows store, with the Flows texts.
 */
import type { FlowRun } from '@durbun/protocol';
import { toast } from '../../components';
import { ui } from '../../data/stores/ui';
import { t } from '../../i18n/core';
import { runErrorText } from './model/run';
import './i18n';

export function notifyFailedRun(run: Omit<FlowRun, 'steps'>): void {
  toast({
    kind: 'error',
    title: t('flows.auto.failed', { name: run.flowName || run.flowId }),
    description: runErrorText(run) ?? run.trigger.detail,
    duration: 12_000,
    action: { label: t('flows.auto.open'), onClick: () => ui.focusFlow(run.flowId, run.id) },
  });
}
