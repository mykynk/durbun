import { describe, expect, it } from 'vitest';
import type { FlowRunHeader } from '@durbun/protocol';
import { flowCountOf, flowsWithCalls, runsOfFlows } from './runs';

const flow = (id: string, calls: string[] = []) => ({ id, calls });
const run = (id: string, flowId: string, status: FlowRunHeader['status'] = 'passed') => ({ id, flowId, status }) as FlowRunHeader;

describe('runs that travel with a share package', () => {
  const flows = [flow('cart', ['login']), flow('login', ['otp']), flow('otp'), flow('admin'), flow('loop', ['loop'])];

  it('the picked flows bring the flows they call, deeper too (as the server packs them)', () => {
    expect([...flowsWithCalls(flows, ['cart'])].sort()).toEqual(['cart', 'login', 'otp']);
    expect([...flowsWithCalls(flows, ['admin'])]).toEqual(['admin']);
    expect([...flowsWithCalls(flows, ['loop'])]).toEqual(['loop']);
    // A deleted sub-flow is not invented.
    expect([...flowsWithCalls([flow('a', ['gone'])], ['a'])]).toEqual(['a']);
  });

  it('only finished runs of those flows: never another flow’s runs', () => {
    const headers = [run('r1', 'cart'), run('r2', 'admin'), run('r3', 'otp', 'failed'), run('r4', 'cart', 'running')];
    const picked = runsOfFlows(headers, flowsWithCalls(flows, ['cart']));
    expect(picked.map((r) => r.id)).toEqual(['r1', 'r3']);
    expect(flowCountOf(picked)).toBe(2);
    expect(runsOfFlows(headers, new Set())).toEqual([]);
  });
});
