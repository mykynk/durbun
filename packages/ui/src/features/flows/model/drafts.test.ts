import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { FlowDoc } from '@durbun/protocol';

const server = vi.hoisted(() => ({ flows: new Map<string, FlowDoc>(), failSave: false }));

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
        if (server.failSave) throw Object.assign(new Error('unreachable'), { status: 0 });
        const stored = server.flows.get(id);
        if (opts.baseUpdatedAt !== undefined && (stored?.updatedAt ?? 0) > opts.baseUpdatedAt + 1) throw Object.assign(new Error('conflict'), { status: 409, code: 'flow.conflict' });
        const saved = { ...flow, id, updatedAt: Date.now() };
        server.flows.set(id, saved);
        return { flow: saved, issues: [] };
      }),
    },
  };
});

import { DRAFT_MAX_AGE_MS, draftIds, readDraft, storeDraft } from './drafts';
import { useFlowDocument } from './useFlowDocument';

const base: FlowDoc = { format: 'durbun-flow', version: 1, id: 'cart', name: 'Cart', nodes: [{ id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } }], edges: [], updatedAt: 1000 };

beforeEach(() => {
  localStorage.clear();
  server.flows = new Map([['cart', base]]);
  server.failSave = false;
});
afterEach(() => vi.useRealTimers());

describe('flow drafts', () => {
  it('stores, reads and lists drafts; old or broken ones are dropped', () => {
    storeDraft('cart', base, 1000, Date.now());
    storeDraft('old', base, 1000, Date.now() - DRAFT_MAX_AGE_MS - 1);
    localStorage.setItem('durbun.flows.draft.broken', '{"nope":1}');
    expect(readDraft('cart')?.flow.name).toBe('Cart');
    expect(draftIds()).toEqual(['cart']);
    expect(localStorage.getItem('durbun.flows.draft.old')).toBeNull();
    expect(localStorage.getItem('durbun.flows.draft.broken')).toBeNull();
  });

  it('keeps edits the server refused on disk, and drops them once a save goes through', async () => {
    const { result } = renderHook(() => useFlowDocument('cart'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    server.failSave = true;
    act(() => result.current.apply((f) => ({ ...f, name: 'Cart v2' })));
    await act(async () => {
      await result.current.flush().catch(() => undefined);
    });
    expect(result.current.save).toBe('error');
    expect(readDraft('cart')?.flow.name).toBe('Cart v2');
    server.failSave = false;
    await act(async () => {
      await result.current.flush();
    });
    expect(result.current.save).toBe('saved');
    expect(readDraft('cart')).toBeNull();
  });

  it('offers a draft from an earlier window back; restoring puts it on the canvas and saves it', async () => {
    storeDraft('cart', { ...base, name: 'Cart (offline edit)' }, 1000);
    const { result } = renderHook(() => useFlowDocument('cart'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.flow?.name).toBe('Cart');
    expect(result.current.draft?.changedSince).toBe(false);
    act(() => result.current.restoreDraft());
    expect(result.current.draft).toBeNull();
    expect(result.current.flow?.name).toBe('Cart (offline edit)');
    expect(result.current.canUndo).toBe(true);
    await act(async () => {
      await result.current.flush();
    });
    expect(server.flows.get('cart')?.name).toBe('Cart (offline edit)');
  });

  it('says when the flow changed elsewhere since the draft, and forgets a draft that matches the server', async () => {
    storeDraft('cart', { ...base, name: 'Old edit' }, 500);
    const { result, rerender } = renderHook(({ id }) => useFlowDocument(id), { initialProps: { id: 'cart' as string | null } });
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    expect(result.current.draft?.changedSince).toBe(true);
    act(() => void result.current.discardDraft());
    expect(readDraft('cart')).toBeNull();

    rerender({ id: null });
    storeDraft('cart', base, 1000);
    rerender({ id: 'cart' });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.draft).toBeNull();
    expect(readDraft('cart')).toBeNull();
  });

  it('stops at a save another window made, keeps the edits, and lets the user pick a version', async () => {
    const { result } = renderHook(() => useFlowDocument('cart'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    server.flows.set('cart', { ...base, name: 'Cart (other window)', updatedAt: 5000 });
    act(() => result.current.apply((f) => ({ ...f, name: 'Cart (mine)' })));
    await act(async () => {
      await result.current.flush().catch(() => undefined);
    });
    expect(result.current.save).toBe('conflict');
    expect(readDraft('cart')?.flow.name).toBe('Cart (mine)');
    expect(server.flows.get('cart')?.name).toBe('Cart (other window)');

    // Load theirs: the other window's version is shown, mine is offered back as a draft.
    act(() => result.current.loadTheirs());
    await waitFor(() => expect(result.current.flow?.name).toBe('Cart (other window)'));
    expect(result.current.draft?.draft.flow.name).toBe('Cart (mine)');
    expect(result.current.draft?.changedSince).toBe(true);

    // Restore it, meet the conflict again, and save mine over theirs.
    server.flows.set('cart', { ...base, name: 'Cart (third)', updatedAt: 9000 });
    act(() => result.current.restoreDraft());
    await act(async () => {
      await result.current.flush().catch(() => undefined);
    });
    expect(result.current.save).toBe('conflict');
    await act(async () => {
      await result.current.keepMine();
    });
    expect(result.current.save).toBe('saved');
    expect(server.flows.get('cart')?.name).toBe('Cart (mine)');
    expect(readDraft('cart')).toBeNull();
  });
});
