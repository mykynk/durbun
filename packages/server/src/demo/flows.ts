/**
 * Example flows of demo mode: what Flows do, against the demo's Pati app (it has the SDK, so requests and mock
 * rules work), runnable without a phone. Added when demo mode starts, unless a flow with the id exists; removed
 * when it stops, unless the user changed it (then it is theirs).
 */
import { isDeepStrictEqual } from 'node:util';
import type { FlowDoc } from '@durbun/protocol';
import { FLOW_FORMAT, FLOW_VERSION } from '@durbun/protocol';

const PATI = 'com.mykynk.pati';

/** Ids of the demo flows (kept stable: the stop removes them by id). */
export const DEMO_FLOW_IDS = ['demo-pati-start', 'demo-pati-list-error'] as const;

export function demoFlows(): FlowDoc[] {
  const base: Pick<FlowDoc, 'format' | 'version' | 'tags' | 'target'> = { format: FLOW_FORMAT, version: FLOW_VERSION, tags: ['demo'], target: { platform: 'any', appId: PATI } };
  return [
    {
      ...base,
      id: 'demo-pati-start',
      name: 'Pati: start and pet list',
      description: 'Restarts Pati, waits for the pet list request, checks it is fast enough and keeps a screenshot. Choose a demo device with Pati running.',
      nodes: [
        { id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } },
        { id: 'restart', type: 'device.restartApp', label: 'Restart Pati', params: { appId: PATI }, position: { x: 260, y: 0 } },
        {
          id: 'petList',
          type: 'wait.network',
          label: 'Pet list loads',
          params: { method: 'GET', url: '/v1/pets?page=1', match: 'contains', status: '2xx', timeoutMs: 20_000 },
          position: { x: 520, y: 0 },
        },
        {
          id: 'fast',
          type: 'check.assert',
          label: 'Under 2 seconds',
          params: { assertions: [{ left: '{{petList.durationMs}}', op: 'lt', right: '2000', message: 'The pet list arrives within 2 s' }] },
          position: { x: 780, y: 0 },
        },
        { id: 'shot', type: 'device.screenshot', label: 'Feed screenshot', params: { name: 'Feed' }, position: { x: 1040, y: 0 } },
        { id: 'noCrash', type: 'check.noErrors', label: 'No crash', params: { networkFailures: false }, position: { x: 1300, y: 0 } },
      ],
      edges: [
        { from: 'start', to: 'restart' },
        { from: 'restart', to: 'petList' },
        { from: 'petList', to: 'fast' },
        { from: 'fast', to: 'shot' },
        { from: 'shot', to: 'noCrash' },
      ],
    },
    {
      ...base,
      id: 'demo-pati-list-error',
      name: 'Pati: pet list server error',
      description:
        'Makes the pet list answer 503 with a mock rule, restarts Pati and checks the app got the error, with a screenshot of what the user sees. The rule is removed when the run ends.',
      nodes: [
        { id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } },
        {
          id: 'outage',
          type: 'mock.add',
          label: 'Pet list returns 503',
          params: {
            name: 'Pet list outage',
            method: 'GET',
            url: '/v1/pets',
            match: 'contains',
            action: 'respond',
            status: 503,
            headers: [['Content-Type', 'application/json']],
            body: '{"error":"maintenance","message":"Back in a few minutes"}',
          },
          position: { x: 260, y: 0 },
        },
        { id: 'restart', type: 'device.restartApp', label: 'Restart Pati', params: { appId: PATI }, position: { x: 520, y: 0 } },
        {
          id: 'failed',
          type: 'wait.network',
          label: 'Pet list fails',
          params: { method: 'GET', url: '/v1/pets?page=1', match: 'contains', status: '5xx', timeoutMs: 20_000 },
          position: { x: 780, y: 0 },
        },
        {
          id: 'is503',
          type: 'check.assert',
          label: 'Got the 503',
          params: { assertions: [{ left: '{{failed.status}}', op: 'equals', right: '503', message: 'The app received the mocked 503' }] },
          position: { x: 1040, y: 0 },
        },
        { id: 'shot', type: 'device.screenshot', label: 'Error screen', params: { name: 'Pet list error' }, position: { x: 1300, y: 0 } },
      ],
      edges: [
        { from: 'start', to: 'outage' },
        { from: 'outage', to: 'restart' },
        { from: 'restart', to: 'failed' },
        { from: 'failed', to: 'is503' },
        { from: 'is503', to: 'shot' },
      ],
    },
  ];
}

/** The parts a user edits: a demo flow whose parts still equal the seed is unchanged. */
export function sameAsSeed(flow: FlowDoc, seed: FlowDoc): boolean {
  // Key order may differ after a save (the store writes its own order): compare values.
  const parts = (f: FlowDoc) => ({ name: f.name, description: f.description ?? '', nodes: f.nodes, edges: f.edges, inputs: f.inputs ?? [], settings: f.settings ?? {} });
  return isDeepStrictEqual(parts(flow), parts(seed));
}
