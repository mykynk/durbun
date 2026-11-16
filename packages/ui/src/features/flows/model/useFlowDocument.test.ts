import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { FlowDoc, FlowSummary } from '@durbun/protocol';

const server = vi.hoisted(() => ({ flows: new Map<string, FlowDoc>(), saves: [] as { id: string; flow: FlowDoc; baseUpdatedAt?: number }[], clock: 1000 }));

vi.mock('../../../data', async (orig) => {
  const real = await orig<typeof import('../../../data')>();
  return {
    ...real,
    api: {
      ...real.api,
      getFlow: vi.fn(async (id: string) => {
        const flow = server.flows.get(id);
        if (!flow) throw Object.assign(new Error('missing'), { status: 404 });
        return { flow, issues: [] };
      }),
      saveFlow: vi.fn(async (id: string, flow: FlowDoc, opts: { baseUpdatedAt?: number } = {}) => {
        server.saves.push({ id, flow, ...opts });
        // Renaming the flow to a name with another id moves it (the server derives ids from names here).
        const newId = flow.id && flow.id !== id ? flow.id : id;
        const saved = { ...flow, id: newId, updatedAt: (server.clock += 1000) };
        server.flows.delete(id);
        server.flows.set(newId, saved);
        return { flow: saved, issues: [] };
      }),
    },
  };
});

import { setFlowSummaries } from '../../../data';
import { useFlowDocument } from './useFlowDocument';

const base: FlowDoc = { format: 'durbun-flow', version: 1, id: 'cart', name: 'Cart', nodes: [{ id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } }], edges: [], updatedAt: 1000 };
const summary = (f: FlowDoc): FlowSummary => ({ id: f.id, name: f.name, nodeCount: f.nodes.length, updatedAt: f.updatedAt, triggers: ['manual'], automation: false, calls: [], issues: { errors: 0, warnings: 0 } });
const rename = (name: string) => (f: FlowDoc) => ({ ...f, name });

beforeEach(() => {
  localStorage.clear();
  server.flows = new Map([['cart', base]]);
  server.saves = [];
  server.clock = 1000;
  setFlowSummaries([summary(base)]);
});
afterEach(() => vi.useRealTimers());

async function open(id: string | null = 'cart', onRenamed?: (from: string, to: string) => void) {
  const hook = renderHook(({ flowId }) => useFlowDocument(flowId, onRenamed), { initialProps: { flowId: id } });
  if (id) await waitFor(() => expect(hook.result.current.status).not.toBe('loading'));
  return hook;
}

describe('the open flow', () => {
  it('loads the flow', async () => {
    const { result } = await open();
    expect(result.current.status).toBe('ready');
    expect(result.current.save).toBe('saved');
    expect(result.current.flow).toMatchObject({ id: 'cart', name: 'Cart' });
  });

  it('lays out steps that have no position (an imported or hand-written flow) and saves the layout', async () => {
    server.flows.set('cart', { ...base, nodes: [{ id: 'start', type: 'trigger.manual' }, { id: 'call', type: 'http.request' }], edges: [{ from: 'start', to: 'call' }] });
    const { result } = await open();
    expect(result.current.flow!.nodes.every((n) => n.position)).toBe(true);
    await waitFor(() => expect(server.saves).toHaveLength(1), { timeout: 2000 });
    expect(server.saves[0]!.flow.nodes.every((n) => n.position)).toBe(true);
  });

  it('says a flow that does not exist is missing, and nothing open is missing too', async () => {
    expect((await open('gone')).result.current.status).toBe('missing');
    expect((await open(null)).result.current.status).toBe('missing');
  });

  it('saves by itself shortly after an edit, against the copy it loaded', async () => {
    const { result } = await open();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    act(() => result.current.apply(rename('Checkout')));
    expect(result.current.save).toBe('dirty');
    expect(server.saves).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await waitFor(() => expect(result.current.save).toBe('saved'));
    expect(server.saves).toEqual([{ id: 'cart', flow: expect.objectContaining({ name: 'Checkout' }), baseUpdatedAt: 1000 }]);
    // The next save is based on what the server answered.
    act(() => result.current.apply(rename('Checkout 2')));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await waitFor(() => expect(server.saves).toHaveLength(2));
    expect(server.saves[1]!.baseUpdatedAt).toBe(2000);
  });

  it('turns typing in one field into one undo step, and redoes it', async () => {
    const { result } = await open();
    act(() => {
      result.current.apply(rename('C'), { coalesce: 'name' });
      result.current.apply(rename('Ca'), { coalesce: 'name' });
      result.current.apply(rename('Car'), { coalesce: 'name' });
    });
    act(() => result.current.apply((f) => ({ ...f, description: 'Buys a thing' })));
    expect(result.current.canUndo).toBe(true);
    act(() => result.current.undo());
    expect(result.current.flow!.description).toBeUndefined();
    expect(result.current.flow!.name).toBe('Car');
    act(() => result.current.undo());
    expect(result.current.flow!.name).toBe('Cart');
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.redo());
    expect(result.current.flow!.name).toBe('Car');
    // A new edit drops what could be redone.
    act(() => result.current.apply(rename('Basket')));
    expect(result.current.canRedo).toBe(false);
  });

  it('ignores an edit that changes nothing', async () => {
    const { result } = await open();
    act(() => result.current.apply((f) => f));
    expect(result.current.canUndo).toBe(false);
    expect(result.current.save).toBe('saved');
  });

  it('saves at once on flush and follows a rename to the new id', async () => {
    const renamed = vi.fn();
    const { result } = await open('cart', renamed);
    act(() => result.current.apply((f) => ({ ...f, id: 'checkout', name: 'Checkout' })));
    let id: string | null = null;
    await act(async () => {
      id = await result.current.flush();
    });
    expect(id).toBe('checkout');
    expect(renamed).toHaveBeenCalledWith('cart', 'checkout');
    expect(result.current.save).toBe('saved');
    // Nothing left to save: flush does not ask the server again.
    await act(async () => {
      await result.current.flush();
    });
    expect(server.saves).toHaveLength(1);
  });

  it('takes a save made elsewhere when nothing is pending here, and keeps the undo step', async () => {
    const { result } = await open();
    const theirs = { ...base, name: 'Cart (edited elsewhere)', updatedAt: 5000 };
    server.flows.set('cart', theirs);
    act(() => setFlowSummaries([summary(theirs)]));
    await waitFor(() => expect(result.current.flow!.name).toBe('Cart (edited elsewhere)'));
    expect(result.current.save).toBe('saved');
    act(() => result.current.undo());
    expect(result.current.flow!.name).toBe('Cart');
  });

  it('does not load a save made elsewhere over edits that are not saved yet', async () => {
    const { result } = await open();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    act(() => result.current.apply(rename('Mine')));
    const theirs = { ...base, name: 'Theirs', updatedAt: 5000 };
    server.flows.set('cart', theirs);
    act(() => setFlowSummaries([summary(theirs)]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(result.current.flow!.name).toBe('Mine');
  });

  it('reads the flow again on reload (a restored version, a conflict resolved elsewhere)', async () => {
    const { result } = await open();
    server.flows.set('cart', { ...base, name: 'Restored', updatedAt: 9000 });
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.flow?.name).toBe('Restored'));
    expect(result.current.canUndo).toBe(false);
  });

  it('describes nothing while switching to another flow (never the one left)', async () => {
    server.flows.set('login', { ...base, id: 'login', name: 'Login' });
    const hook = await open();
    hook.rerender({ flowId: 'login' });
    expect(hook.result.current.flow?.id ?? null).not.toBe('cart');
    await waitFor(() => expect(hook.result.current.flow?.name).toBe('Login'));
  });
});
