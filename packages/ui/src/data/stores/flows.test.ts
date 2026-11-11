import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowRun, FlowRunHeader, FlowRunStep } from '@durbun/protocol';
import { applyFlowRunDelta, latestRunOf, rememberFlowRun, useFlows } from './flows';

const step = (id: number, nodeId: string): FlowRunStep => ({ id, nodeId, type: 'http.request', status: 'passed', startedAt: 1, endedAt: 2 }) as FlowRunStep;
const run = (status: FlowRun['status'], steps: FlowRunStep[], extra: Partial<FlowRun> = {}): FlowRun =>
  ({ id: 'r1', flowId: 'f', flowName: 'F', status, startedAt: 100, steps, ...extra }) as FlowRun;
const header = (status: FlowRun['status'], extra: Partial<FlowRun> = {}): FlowRunHeader => {
  const { steps: _s, ...h } = run(status, [], extra);
  return { ...h, stepCount: 0 } as FlowRunHeader;
};

describe('flow run store', () => {
  beforeEach(() => useFlows.setState({ summaries: [], loaded: false, runs: {} }));

  it('merges deltas by step id', () => {
    applyFlowRunDelta({ run: header('running'), steps: [step(1, 'start')] });
    applyFlowRunDelta({ run: header('running'), steps: [step(2, 'list'), step(1, 'start')] });
    expect(useFlows.getState().runs.r1!.steps.map((s) => s.nodeId)).toEqual(['start', 'list']);
  });

  it('a run that finished over the socket is not rolled back by the late answer that started it', () => {
    applyFlowRunDelta({ run: header('running'), steps: [step(1, 'start')] });
    applyFlowRunDelta({ run: header('passed', { endedAt: 120 }), steps: [step(2, 'list')] });
    rememberFlowRun(run('running', [step(1, 'start')]));
    const r = useFlows.getState().runs.r1!;
    expect(r.status).toBe('passed');
    expect(r.steps).toHaveLength(2);
  });

  it('a running copy with more steps wins over a stale read, a finished read replaces a running copy', () => {
    applyFlowRunDelta({ run: header('running'), steps: [step(1, 'start'), step(2, 'list')] });
    rememberFlowRun(run('running', [step(1, 'start')]));
    expect(useFlows.getState().runs.r1!.steps).toHaveLength(2);
    rememberFlowRun(run('failed', [step(1, 'start'), step(2, 'list'), step(3, 'check')]));
    expect(useFlows.getState().runs.r1!.status).toBe('failed');
  });

  it('latestRunOf prefers a running run, then the newest', () => {
    const runs = {
      a: run('passed', [], { id: 'a', startedAt: 300 }),
      b: run('running', [], { id: 'b', startedAt: 200 }),
      c: run('failed', [], { id: 'c', startedAt: 100 }),
    };
    expect(latestRunOf(runs, 'f')?.id).toBe('b');
    expect(latestRunOf({ a: runs.a, c: runs.c }, 'f')?.id).toBe('a');
    expect(latestRunOf(runs, 'other')).toBeUndefined();
  });
});
