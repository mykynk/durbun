/**
 * Ready-made flows a first-time tester can add in one click, to see what a flow does before building one: they run
 * against the app picked for the run (`{{target.appId}}`), need no environment and change nothing outside the
 * device. Names, descriptions and screenshot names are written in the UI language when the flow is created.
 */
import { Camera, RotateCcw, Siren, type LucideIcon } from 'lucide-react';
import { FLOW_FORMAT, FLOW_VERSION, type FlowDoc, type FlowEdge, type FlowNode } from '@durbun/protocol';
import type { TFunction } from '../../../i18n';

export type StarterId = 'freshStart' | 'smoke' | 'crashShot';

export interface Starter {
  id: StarterId;
  icon: LucideIcon;
}

export const STARTERS: readonly Starter[] = [
  { id: 'freshStart', icon: Camera },
  { id: 'smoke', icon: RotateCcw },
  { id: 'crashShot', icon: Siren },
];

type Step = Omit<FlowNode, 'position'>;

/** Steps in a row, each leading to the next. */
function chain(steps: Step[]): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes = steps.map((s, i) => ({ ...s, position: { x: i * 260, y: 0 } }));
  const edges = steps.slice(1).map((s, i) => ({ from: steps[i]!.id, to: s.id }));
  return { nodes, edges };
}

/** The flow document of a starter (the server picks a free id from the name). */
export function starterFlow(id: StarterId, t: TFunction): Omit<FlowDoc, 'id'> {
  const base = { format: FLOW_FORMAT, version: FLOW_VERSION, name: t(`flows.starters.${id}.name`), description: t(`flows.starters.${id}.description`) } as const;
  switch (id) {
    case 'freshStart':
      return {
        ...base,
        ...chain([
          { id: 'start', type: 'trigger.manual' },
          { id: 'clearData', type: 'device.clearData' },
          { id: 'launch', type: 'device.launchApp' },
          { id: 'settle', type: 'logic.delay', params: { durationMs: 3000 } },
          { id: 'firstScreen', type: 'device.screenshot', params: { name: t('flows.starters.freshStart.shot') } },
          { id: 'noErrors', type: 'check.noErrors' },
        ]),
      };
    case 'smoke':
      return {
        ...base,
        ...chain([
          { id: 'start', type: 'trigger.manual' },
          { id: 'restart', type: 'device.restartApp' },
          { id: 'settle', type: 'logic.delay', params: { durationMs: 5000 } },
          { id: 'noErrors', type: 'check.noErrors', params: { networkFailures: true, errorLogs: true } },
          { id: 'screen', type: 'device.screenshot', params: { name: t('flows.starters.smoke.shot') } },
        ]),
      };
    case 'crashShot':
      // Starts by itself only after its automation switch is turned on (off when created).
      return {
        ...base,
        ...chain([
          { id: 'onCrash', type: 'trigger.event', params: { event: 'crash' } },
          { id: 'crashScreen', type: 'device.screenshot', params: { name: t('flows.starters.crashShot.shot') } },
        ]),
      };
  }
}
