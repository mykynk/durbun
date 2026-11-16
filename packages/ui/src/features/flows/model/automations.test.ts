import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowDoc, FlowSummary } from '@durbun/protocol';

const server = vi.hoisted(() => ({ flows: new Map<string, FlowDoc>(), conflictOnce: new Set<string>(), fail: new Set<string>() }));

vi.mock('../../../data', async (orig) => {
  const real = await orig<typeof import('../../../data')>();
  return {
    ...real,
    api: {
      ...real.api,
      getFlow: vi.fn(async (id: string) => ({ flow: server.flows.get(id)!, issues: [] })),
      saveFlow: vi.fn(async (id: string, flow: FlowDoc, opts: { baseUpdatedAt?: number }) => {
        if (server.fail.has(id)) throw new Error('disk full');
        if (server.conflictOnce.delete(id)) {
          const bumped = { ...server.flows.get(id)!, description: 'edited elsewhere', updatedAt: (opts.baseUpdatedAt ?? 0) + 5 };
          server.flows.set(id, bumped);
          throw new real.ApiError(409, 'conflict', 'flow.conflict');
        }
        const saved = { ...flow, updatedAt: (flow.updatedAt ?? 0) + 1 };
        server.flows.set(id, saved);
        return { flow: saved, issues: [] };
      }),
    },
  };
});

import { automatedFlows, pauseAutomations, resumable, resumeAutomations, usePausedAutomations } from './automations';

const doc = (id: string, enabled: boolean): FlowDoc => ({ format: 'durbun-flow', version: 1, id, name: id, nodes: [], edges: [], automation: { enabled, throttleMs: 5000 }, updatedAt: 10 });
const summary = (id: string, automation: boolean, trigger: 'event' | 'manual' = 'event'): FlowSummary => ({ id, name: id, nodeCount: 1, triggers: [trigger], automation, calls: [], issues: { errors: 0, warnings: 0 } });

beforeEach(() => {
  localStorage.clear();
  usePausedAutomations.setState({ ids: [] });
  server.flows = new Map([
    ['a', doc('a', true)],
    ['b', doc('b', true)],
  ]);
  server.conflictOnce.clear();
  server.fail.clear();
});

describe('automations', () => {
  it('lists only flows that start on their own', () => {
    expect(automatedFlows([summary('b', true), summary('a', true), summary('c', false), summary('d', true, 'manual')]).map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('pauses all, keeps edits saved meanwhile, and resumes the same set', async () => {
    server.conflictOnce.add('b');
    const res = await pauseAutomations(['a', 'b']);
    expect(res.done).toEqual(['a', 'b']);
    expect(server.flows.get('a')?.automation).toEqual({ enabled: false, throttleMs: 5000 });
    expect(server.flows.get('b')?.description).toBe('edited elsewhere');
    expect(server.flows.get('b')?.automation?.enabled).toBe(false);
    expect(usePausedAutomations.getState().ids).toEqual(['a', 'b']);
    expect(JSON.parse(localStorage.getItem('durbun.flows.pausedAutomations')!)).toEqual(['a', 'b']);

    const back = resumable(usePausedAutomations.getState().ids, [summary('a', false), summary('b', false)]);
    await resumeAutomations(back.map((f) => f.id));
    expect(server.flows.get('a')?.automation?.enabled).toBe(true);
    expect(server.flows.get('b')?.automation?.enabled).toBe(true);
    expect(usePausedAutomations.getState().ids).toEqual([]);
  });

  it('reports a flow it could not switch and keeps it for the next resume', async () => {
    server.flows.set('a', doc('a', false));
    server.flows.set('b', doc('b', false));
    usePausedAutomations.setState({ ids: ['a', 'b'] });
    server.fail.add('b');
    const res = await resumeAutomations(['a', 'b']);
    expect(res.done).toEqual(['a']);
    expect(res.failed.map((f) => f.id)).toEqual(['b']);
    expect(usePausedAutomations.getState().ids).toEqual(['b']);
  });
});
