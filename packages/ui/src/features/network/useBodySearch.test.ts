/** `useBodySearch`: debounce, abort on a new text, inactive / empty states, a stable result set, errors. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBodySearch } from './useBodySearch';

let calls: { text: string; signal?: AbortSignal | null }[] = [];
let answer: (text: string) => Response | Promise<Response>;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  answer = (text) => new Response(JSON.stringify({ ids: text === 'none' ? [] : ['n1', 'n2'] }), { status: 200 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { text: string };
      calls.push({ text: body.text, signal: init?.signal });
      return answer(body.text);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(310)));

describe('useBodySearch', () => {
  it('no text: nothing searched, nothing loading', async () => {
    const { result } = renderHook(() => useBodySearch('', true));
    await settle();
    expect(result.current).toEqual({ matches: null, loading: false, error: null });
    expect(calls).toHaveLength(0);
  });

  it('searches 300 ms after the last keystroke, only for the last text', async () => {
    const { result, rerender } = renderHook(({ text }) => useBodySearch(text, true), { initialProps: { text: 't' } });
    expect(result.current.loading).toBe(true);
    await act(async () => void (await vi.advanceTimersByTimeAsync(100)));
    rerender({ text: 'to' });
    await act(async () => void (await vi.advanceTimersByTimeAsync(100)));
    rerender({ text: 'tok' });
    await settle();
    expect(calls.map((c) => c.text)).toEqual(['tok']);
    expect(result.current.loading).toBe(false);
    expect([...(result.current.matches ?? [])]).toEqual(['n1', 'n2']);
  });

  it('an inactive tab does not search; becoming active does', async () => {
    const { result, rerender } = renderHook(({ active }) => useBodySearch('tok', active), { initialProps: { active: false } });
    await settle();
    expect(calls).toHaveLength(0);
    rerender({ active: true });
    await settle();
    expect(calls).toHaveLength(1);
    expect(result.current.matches?.size).toBe(2);
  });

  it('the same result keeps the same set (no needless re-filtering); clearing the text resets', async () => {
    const { result, rerender } = renderHook(({ text }) => useBodySearch(text, true), { initialProps: { text: 'abc' } });
    await settle();
    const first = result.current.matches;
    rerender({ text: 'abcd' });
    await settle();
    expect(result.current.matches).toBe(first);
    rerender({ text: 'none' });
    await settle();
    expect(result.current.matches?.size).toBe(0);
    rerender({ text: '' });
    await settle();
    expect(result.current).toEqual({ matches: null, loading: false, error: null });
  });

  it('a new text aborts the request in flight; its late answer is dropped', async () => {
    let release!: () => void;
    answer = (text) =>
      text === 'slow'
        ? new Promise<Response>((r) => (release = () => r(new Response(JSON.stringify({ ids: ['old'] }), { status: 200 }))))
        : new Response(JSON.stringify({ ids: ['new'] }), { status: 200 });
    const { result, rerender } = renderHook(({ text }) => useBodySearch(text, true), { initialProps: { text: 'slow' } });
    await settle();
    expect(calls).toHaveLength(1);
    rerender({ text: 'fast' });
    expect(calls[0]!.signal?.aborted).toBe(true);
    await settle();
    await act(async () => release());
    expect([...(result.current.matches ?? [])]).toEqual(['new']);
  });

  it('a failed search keeps the error and stops loading', async () => {
    answer = () => new Response(JSON.stringify({ error: 'boom', code: 'internal' }), { status: 500 });
    const { result } = renderHook(() => useBodySearch('tok', true));
    await settle();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeTruthy();
    expect(result.current.matches).toBeNull();
  });
});
