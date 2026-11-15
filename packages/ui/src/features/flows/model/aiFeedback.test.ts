import { describe, expect, it } from 'vitest';
import type { FlowDoc, FlowIssue } from '@durbun/protocol';
import { flowDiff, isEmptyDiff, issuesForAi } from './aiFeedback';

const issue = (over: Partial<FlowIssue>): FlowIssue => ({ level: 'error', code: 'flow.param.required', message: 'URL is required', ...over });

describe('errors for the AI', () => {
  it('lists every problem in English with the step id, path and code, errors first', () => {
    const issues = [issue({ level: 'warning', code: 'flow.node.unreachable', message: 'Never reached', nodeId: 'orphan' }), ...Array.from({ length: 10 }, (_, i) => issue({ nodeId: `s${i}`, path: `nodes[${i}].params.url` }))];
    const text = issuesForAi([{ flow: { id: 'login', name: 'Giriş' }, issues }], ['Not valid JSON: Unexpected token']);
    expect(text).toContain('Not valid JSON: Unexpected token');
    expect(text).toContain('Flow "login" (Giriş): 10 error(s), 1 warning(s)');
    expect(text).toContain('- error flow.param.required (step "s9" at nodes[9].params.url): URL is required');
    expect(text.indexOf('flow.param.required')).toBeLessThan(text.indexOf('flow.node.unreachable'));
    expect(text.split('\n').filter((l) => l.startsWith('- error')).length).toBe(10);
  });

  it('is empty when there is nothing to fix', () => {
    expect(issuesForAi([{ flow: { id: 'a', name: 'A' }, issues: [] }], [])).toBe('');
  });
});

describe('flowDiff', () => {
  const base = {
    id: 'f',
    name: 'Login',
    nodes: [
      { id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } },
      { id: 'call', type: 'http.request', params: { url: 'https://a/login', method: 'POST' }, position: { x: 200, y: 0 } },
      { id: 'wait', type: 'logic.delay', params: { ms: 100 } },
    ],
    edges: [{ from: 'start', to: 'call' }, { from: 'call', to: 'wait' }],
  } as unknown as FlowDoc;

  it('names added, removed and changed steps and counts link changes', () => {
    const next = {
      ...base,
      name: 'Login v2',
      nodes: [base.nodes[0], { ...base.nodes[1], params: { url: 'https://a/v2/login', method: 'POST' }, position: { x: 400, y: 40 } }, { id: 'check', type: 'check.noErrors' }],
      edges: [{ from: 'start', to: 'call' }, { from: 'call', to: 'check' }],
    } as unknown as FlowDoc;
    const d = flowDiff(base, next);
    expect(d.renamed).toBe(true);
    expect(d.added.map((n) => n.id)).toEqual(['check']);
    expect(d.removed.map((n) => n.id)).toEqual(['wait']);
    expect(d.changed).toEqual([{ node: next.nodes[1], fields: ['url'] }]);
    expect([d.linksAdded, d.linksRemoved]).toEqual([1, 1]);
  });

  it('moving steps on the canvas is not a change', () => {
    const moved = { ...base, nodes: base.nodes.map((n) => ({ ...n, position: { x: 9, y: 9 } })) } as FlowDoc;
    expect(isEmptyDiff(flowDiff(base, moved))).toBe(true);
  });
});
