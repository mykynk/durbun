import { describe, expect, it } from 'vitest';
import type { FlowDoc, FlowNode } from '@durbun/protocol';
import {
  addNode,
  connect,
  connectProblem,
  copyNodes,
  downstream,
  edgeKey,
  GRID,
  linksInto,
  linksOf,
  moveNodes,
  NODE_H,
  NODE_W,
  parseClipboard,
  pasteNodes,
  removeNodes,
  removeNodesBridged,
  renameNode,
  renameProblem,
  upstream,
} from './graph';

const node = (id: string, type: string, x = 0, y = 0, params?: Record<string, unknown>): FlowNode => ({ id, type, position: { x, y }, ...(params ? { params } : {}) });

/** start → login → check, with check's false branch to fail. */
function sample(): FlowDoc {
  return {
    format: 'durbun-flow',
    version: 1,
    id: 'f',
    name: 'Sample',
    nodes: [
      node('start', 'trigger.manual', 0, 0),
      node('login', 'http.request', 300, 0, { method: 'POST', url: 'https://api.example.test/login' }),
      node('check', 'logic.condition', 600, 0, { rules: [{ left: '{{login.status}}', op: 'eq', right: '200' }] }),
      node('fail', 'flow.end', 900, 120),
    ],
    edges: [
      { from: 'start', to: 'login' },
      { from: 'login', to: 'check' },
      { from: 'check', port: 'false', to: 'fail' },
    ],
  } as FlowDoc;
}

describe('adding steps', () => {
  it('connects a step added after another, places it to the right and gives it a fresh id', () => {
    const { flow, id } = addNode(sample(), 'http.request', { after: { nodeId: 'login', port: 'out' } });
    expect(id).not.toBe('login');
    expect(flow.nodes.map((n) => n.id)).toContain(id);
    expect(flow.edges).toContainEqual({ from: 'login', to: id });
    const placed = flow.nodes.find((n) => n.id === id)!.position!;
    expect(placed.x).toBeGreaterThan(300 + NODE_W);
    expect(placed.x % GRID).toBe(0);
    expect(placed.y % GRID).toBe(0);
  });

  it('never drops a new step on top of another one', () => {
    const { flow, id } = addNode(sample(), 'logic.delay', { at: { x: 300, y: 0 } });
    const placed = flow.nodes.find((n) => n.id === id)!.position!;
    expect(placed).not.toEqual({ x: 300, y: 0 });
    expect(Math.abs(placed.y - 0)).toBeGreaterThanOrEqual(NODE_H);
  });

  it('does not wire a trigger after another step', () => {
    const { flow, id } = addNode(sample(), 'trigger.manual', { after: { nodeId: 'login', port: 'out' } });
    expect(flow.edges.some((e) => e.to === id)).toBe(false);
  });
});

describe('connections', () => {
  it('explains why a connection is refused', () => {
    const f = sample();
    expect(connectProblem(f, 'login', 'out', 'start')).toBe('trigger');
    expect(connectProblem(f, 'login', 'out', 'login')).toBe('self');
    expect(connectProblem(f, 'start', 'out', 'login')).toBe('duplicate');
    expect(connectProblem(f, 'login', 'true', 'fail')).toBe('port');
    expect(connectProblem(f, 'check', 'true', 'fail')).toBeNull();
  });

  it('adds only allowed connections, with the port written only when it is not "out"', () => {
    const f = sample();
    expect(connect(f, 'login', 'out', 'login')).toBe(f);
    expect(connect(f, 'check', 'true', 'fail').edges).toContainEqual({ from: 'check', port: 'true', to: 'fail' });
    expect(connect(f, 'login', 'out', 'fail').edges).toContainEqual({ from: 'login', to: 'fail' });
  });

  it('lists links out per port and links in', () => {
    const f = connect(sample(), 'check', 'true', 'fail');
    expect(linksOf(f, 'check')).toEqual([
      { port: 'true', to: ['fail'] },
      { port: 'false', to: ['fail'] },
    ]);
    expect(linksInto(f, 'fail')).toEqual([
      { from: 'check', port: 'false' },
      { from: 'check', port: 'true' },
    ]);
  });
});

describe('removing steps', () => {
  it('removes a step with its connections', () => {
    const f = removeNodes(sample(), new Set(['login']));
    expect(f.nodes.map((n) => n.id)).toEqual(['start', 'check', 'fail']);
    expect(f.edges.map(edgeKey).some((k) => k.includes('login'))).toBe(false);
  });

  it('keeps the chain when a middle step is removed (A → B → C becomes A → C)', () => {
    const f = removeNodesBridged(sample(), new Set(['login']));
    expect(f.edges).toContainEqual({ from: 'start', to: 'check' });
    // A branching step is not bridged: there is no single way out.
    const g = removeNodesBridged(sample(), new Set(['check']));
    expect(g.edges).toEqual([{ from: 'start', to: 'login' }]);
  });
});

describe('moving and renaming', () => {
  it('snaps moved steps to the grid and leaves the others', () => {
    const f = moveNodes(sample(), new Map([['login', { x: 303, y: 13 }]]));
    expect(f.nodes.find((n) => n.id === 'login')!.position).toEqual({ x: 304, y: 16 });
    expect(f.nodes.find((n) => n.id === 'check')!.position).toEqual({ x: 600, y: 0 });
  });

  it('renames a step everywhere: edges and the templates that read it', () => {
    const f = renameNode(sample(), 'login', 'signIn');
    expect(f.nodes.map((n) => n.id)).toContain('signIn');
    expect(f.edges).toContainEqual({ from: 'start', to: 'signIn' });
    expect(JSON.stringify(f.nodes.find((n) => n.id === 'check')!.params)).toContain('{{signIn.status}}');
  });

  it('refuses ids that are taken, reserved or malformed', () => {
    const f = sample();
    expect(renameProblem(f, 'login', 'check')).toBe('taken');
    expect(renameProblem(f, 'login', 'env')).toBe('reserved');
    expect(renameProblem(f, 'login', 'has space')).toBe('invalid');
    expect(renameProblem(f, 'login', 'login')).toBeNull();
    expect(renameNode(f, 'login', 'check')).toBe(f);
  });
});

describe('copy and paste', () => {
  it('copies steps with the connections between them only', () => {
    const clip = copyNodes(sample(), new Set(['login', 'check']));
    expect(clip.nodes.map((n) => n.id)).toEqual(['login', 'check']);
    expect(clip.edges).toEqual([{ from: 'login', to: 'check' }]);
    expect(parseClipboard(JSON.stringify(clip))).toEqual(clip);
    expect(parseClipboard('{"nodes": []}')).toBeNull();
    expect(parseClipboard('not json')).toBeNull();
  });

  it('pastes with new ids, offset, and templates that follow the new ids', () => {
    const f = sample();
    const { flow, ids } = pasteNodes(f, copyNodes(f, new Set(['login', 'check'])));
    expect(ids).toHaveLength(2);
    expect(ids.some((id) => id === 'login' || id === 'check')).toBe(false);
    const [login, check] = ids.map((id) => flow.nodes.find((n) => n.id === id)!);
    expect(login!.position).toEqual({ x: 344, y: 40 });
    expect(flow.edges).toContainEqual({ from: login!.id, to: check!.id });
    expect(JSON.stringify(check!.params)).toContain(`{{${login!.id}.status}}`);
    expect(flow.nodes).toHaveLength(6);
  });
});

describe('reachability', () => {
  it('knows what runs after a step and what ran before it', () => {
    const f = sample();
    expect([...downstream(f, 'login')].sort()).toEqual(['check', 'fail', 'login']);
    expect([...upstream(f, 'check')].sort()).toEqual(['login', 'start']);
    expect(upstream(f, 'start').size).toBe(0);
  });
});
