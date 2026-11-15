import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStorage, writeStorage } from '../../lib/persist';
import { markApplying, QUERY_STATE_KEY, recoverFromHang, RESPONSIVE_MS } from './hangGuard';

describe('hang guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it('clears its mark once the page stayed responsive', () => {
    writeStorage(QUERY_STATE_KEY, 'message~:(a+)+$');
    markApplying('query');
    vi.advanceTimersByTime(RESPONSIVE_MS);
    const disable = vi.fn();
    expect(recoverFromHang(disable)).toEqual([]);
    expect(readStorage(QUERY_STATE_KEY, '')).toBe('message~:(a+)+$');
    expect(disable).not.toHaveBeenCalled();
  });

  it('a mark left by a hung page drops the saved query and the regex highlights at the next start', () => {
    writeStorage(QUERY_STATE_KEY, 'message~:(a+)+$');
    markApplying('query');
    markApplying('highlight');
    // The page hangs: the timer never runs. Next start:
    const disable = vi.fn();
    expect(recoverFromHang(disable)).toEqual(['query', 'highlight']);
    expect(readStorage(QUERY_STATE_KEY, 'x')).toBe('');
    expect(disable).toHaveBeenCalledOnce();
    expect(recoverFromHang(disable)).toEqual([]);
  });
});
