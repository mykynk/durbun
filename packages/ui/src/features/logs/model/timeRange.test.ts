import { describe, expect, it } from 'vitest';
import { MIN_RANGE_MS, inRange, rangeAround, rangeBetween } from './timeRange';

describe('log time range', () => {
  it('centres a range on a line', () => {
    expect(rangeAround({ id: 7, ts: 100_000 }, 10_000)).toEqual({ from: 90_000, to: 110_000, anchor: { id: 7, ts: 100_000 }, half: 10_000 });
  });
  it('orders two moments and keeps a minimum width', () => {
    expect(rangeBetween(5_000, 2_000)).toEqual({ from: 2_000, to: 5_000 });
    const narrow = rangeBetween(10_000, 10_000);
    expect(narrow.to - narrow.from).toBe(MIN_RANGE_MS);
  });
  it('treats no range as everything', () => {
    expect(inRange(null, 1)).toBe(true);
    expect(inRange({ from: 0, to: 10 }, 10)).toBe(true);
    expect(inRange({ from: 0, to: 10 }, 11)).toBe(false);
  });
});
