import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { parseDesktopPrefs, useDesktopPrefs } from './desktopPrefs';

const w = window as unknown as { durbunDesktop?: unknown };
afterEach(() => {
  delete w.durbunDesktop;
});

describe('Mac app settings bridge', () => {
  it('is absent in a browser: the rows stay hidden', () => {
    const { result } = renderHook(() => useDesktopPrefs());
    expect(result.current.available).toBe(false);
    expect(result.current.prefs).toBeUndefined();
  });

  it('reads, writes and reads again when the menu changed a value', async () => {
    let state = { autoUpdateCheck: null as boolean | null, openAtLogin: false, openAtLoginAvailable: true };
    const get = vi.fn(async () => state);
    const set = vi.fn(async (patch: object) => (state = { ...state, ...patch }));
    w.durbunDesktop = { prefs: { get, set } };
    const { result } = renderHook(() => useDesktopPrefs());
    expect(result.current.available).toBe(true);
    await waitFor(() => expect(result.current.prefs?.autoUpdateCheck).toBeNull());
    await act(async () => {
      expect(await result.current.set({ autoUpdateCheck: true })).toBe(true);
    });
    expect(set).toHaveBeenCalledWith({ autoUpdateCheck: true });
    expect(result.current.prefs?.autoUpdateCheck).toBe(true);
    state = { ...state, openAtLogin: true };
    act(() => {
      window.dispatchEvent(new CustomEvent('durbun:command', { detail: 'prefs-changed' }));
    });
    await waitFor(() => expect(result.current.prefs?.openAtLogin).toBe(true));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('ignores a reply of another shape', () => {
    expect(parseDesktopPrefs({ autoUpdateCheck: 'yes', openAtLogin: false })).toBeUndefined();
    expect(parseDesktopPrefs({ autoUpdateCheck: false, openAtLogin: true })).toEqual({ autoUpdateCheck: false, openAtLogin: true, openAtLoginAvailable: true });
  });
});
