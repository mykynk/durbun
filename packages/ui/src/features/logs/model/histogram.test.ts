import { describe, expect, it } from 'vitest';
import { HistogramIndex } from './histogram';
import { Ledger } from './ledger';
import { SEV_ERROR, SEV_OTHER, SEV_WARN, severityOf } from './types';

const T0 = 1_700_000_000_000;

describe('HistogramIndex', () => {
  it('buckets per second and aggregates into display buckets', () => {
    const h = new HistogramIndex(1000);
    for (let i = 0; i < 10; i++) h.add(T0 + i * 1000, SEV_OTHER);
    h.add(T0 + 2500, SEV_ERROR);
    h.add(T0 + 2600, SEV_WARN);
    expect(h.total).toBe(12);
    const v = h.view(5);
    expect(v.count).toBe(5);
    expect(v.from).toBe(T0);
    expect(v.to).toBe(T0 + 10_000);
    expect(v.step).toBe(2000);
    expect([...v.other]).toEqual([2, 2, 2, 2, 2]);
    expect(v.err[1]).toBe(1);
    expect(v.warn[1]).toBe(1);
    expect(v.max).toBe(4);
  });

  it('never makes buckets narrower than the base resolution', () => {
    const h = new HistogramIndex(1000);
    h.add(T0, SEV_OTHER);
    h.add(T0 + 2000, SEV_OTHER);
    const v = h.view(300);
    expect(v.count).toBe(3);
  });

  it('pads short spans to the minimum, ending at the newest data', () => {
    const h = new HistogramIndex(1000);
    h.add(T0, SEV_OTHER);
    h.add(T0 + 2000, SEV_ERROR);
    const v = h.view(100, 60_000);
    expect(v.to).toBe(T0 + 3000);
    expect(v.from).toBe(T0 + 3000 - 60_000);
    expect(v.count).toBe(60);
    expect(v.other[57]).toBe(1);
    expect(v.err[59]).toBe(1);
  });

  it('removes counts and drops empty buckets', () => {
    const h = new HistogramIndex(1000);
    h.add(T0, SEV_WARN, 3);
    h.remove(T0, SEV_WARN, 2);
    expect(h.total).toBe(1);
    expect(h.size).toBe(1);
    h.remove(T0, SEV_WARN);
    expect(h.size).toBe(0);
    expect(h.view(10).count).toBe(0);
    h.remove(T0 + 99_000, SEV_OTHER); // unknown bucket: ignored
    expect(h.total).toBe(0);
  });

  it('ignores non-finite timestamps', () => {
    const h = new HistogramIndex();
    h.add(Number.NaN, SEV_OTHER);
    expect(h.total).toBe(0);
  });

  it('maps levels to severity tiers', () => {
    expect(severityOf('fatal')).toBe(SEV_ERROR);
    expect(severityOf('error')).toBe(SEV_ERROR);
    expect(severityOf('warn')).toBe(SEV_WARN);
    expect(severityOf('verbose')).toBe(SEV_OTHER);
  });
});

describe('Ledger', () => {
  it('grows past its capacity, keeps order and finds ids', () => {
    const l = new Ledger(16);
    for (let i = 1; i <= 100; i++) l.push(i * 2, T0 + i, i % 7);
    expect(l.length).toBe(100);
    expect(l.capacity).toBeGreaterThanOrEqual(100);
    expect(l.frontId()).toBe(2);
    expect(l.indexOf(50)).toBe(24);
    expect(l.indexOf(51)).toBe(-1);
    for (let i = 0; i < 30; i++) l.dropFront();
    expect(l.frontId()).toBe(62);
    expect(l.indexOf(50)).toBe(-1);
    // wrap-around after drops
    for (let i = 101; i <= 150; i++) l.push(i * 2, T0 + i, 1);
    expect(l.length).toBe(120);
    expect(l.indexOf(300)).toBe(119);
    l.setFlagsAt(0, 9);
    expect(l.flagsAt(0)).toBe(9);
    expect(l.tsAt(0)).toBe(T0 + 31);
    l.clear();
    expect(l.frontId()).toBe(Infinity);
  });
});
