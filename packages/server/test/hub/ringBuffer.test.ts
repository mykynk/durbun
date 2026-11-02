import { describe, expect, it } from 'vitest';
import { RingBuffer } from '../../src/hub/ringBuffer';

describe('RingBuffer', () => {
  it('appends in order and evicts the oldest once full', () => {
    const ring = new RingBuffer<number>(3);
    expect(ring.push(1)).toBeUndefined();
    ring.push(2);
    ring.push(3);
    expect(ring.toArray()).toEqual([1, 2, 3]);
    expect(ring.push(4)).toBe(1);
    expect(ring.push(5)).toBe(2);
    expect(ring.toArray()).toEqual([3, 4, 5]);
    expect(ring.size).toBe(3);
    expect(ring.first()).toBe(3);
    expect(ring.last()).toBe(5);
    expect(ring.at(1)).toBe(4);
    expect(ring.at(3)).toBeUndefined();
  });

  it('grows its backing array lazily past the initial slots', () => {
    const ring = new RingBuffer<number>(5000);
    for (let i = 0; i < 4000; i++) ring.push(i);
    expect(ring.size).toBe(4000);
    expect(ring.at(0)).toBe(0);
    expect(ring.at(3999)).toBe(3999);
    for (let i = 4000; i < 7000; i++) ring.push(i);
    expect(ring.size).toBe(5000);
    expect(ring.first()).toBe(2000);
    expect(ring.last()).toBe(6999);
  });

  it('slices, retains and shrinks/grows capacity', () => {
    const ring = new RingBuffer<number>(4);
    for (let i = 1; i <= 6; i++) ring.push(i); // wraps: [3,4,5,6]
    expect(ring.slice(1, 3)).toEqual([4, 5]);
    expect(ring.retain((n) => n % 2 === 0)).toEqual([3, 5]);
    expect(ring.toArray()).toEqual([4, 6]);
    ring.push(7);
    ring.push(8);
    expect(ring.toArray()).toEqual([4, 6, 7, 8]);
    expect(ring.setCapacity(2)).toEqual([4, 6]);
    expect(ring.toArray()).toEqual([7, 8]);
    ring.push(9);
    expect(ring.toArray()).toEqual([8, 9]);
    ring.setCapacity(10);
    for (let i = 10; i < 15; i++) ring.push(i);
    expect(ring.toArray()).toEqual([8, 9, 10, 11, 12, 13, 14]);
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.toArray()).toEqual([]);
  });

  it('binary-searches sorted keys (upperBound) across the wrap point', () => {
    const ring = new RingBuffer<{ id: number }>(5);
    for (let id = 1; id <= 8; id++) ring.push({ id }); // keeps 4..8
    const key = (e: { id: number }) => e.id;
    expect(ring.upperBound(0, key)).toBe(0);
    expect(ring.upperBound(4, key)).toBe(1);
    expect(ring.upperBound(6, key)).toBe(3);
    expect(ring.upperBound(8, key)).toBe(5);
    expect(ring.upperBound(100, key)).toBe(5);
  });

  it('treats invalid capacities as 1', () => {
    const ring = new RingBuffer<number>(0);
    ring.push(1);
    ring.push(2);
    expect(ring.toArray()).toEqual([2]);
    expect(new RingBuffer<number>(Number.NaN).capacity).toBe(1);
  });
});
