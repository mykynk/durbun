import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatClock,
  formatCompact,
  formatDuration,
  formatNumber,
  formatOffset,
  formatPercent,
  formatRelative,
  formatTime,
} from '../lib/format';

describe('formatBytes', () => {
  it('uses binary units and the language decimal separator', () => {
    expect(formatBytes(0, { lang: 'en' })).toBe('0 B');
    expect(formatBytes(1023, { lang: 'en' })).toBe('1023 B');
    expect(formatBytes(4300, { lang: 'en' })).toBe('4.2 KB');
    expect(formatBytes(4300, { lang: 'tr' })).toBe('4,2 KB');
    expect(formatBytes(5 * 1024 * 1024, { lang: 'en' })).toBe('5 MB');
    expect(formatBytes(84_211, { lang: 'en' })).toBe('82 KB');
    expect(formatBytes(3.5 * 1024 ** 3, { lang: 'tr' })).toBe('3,5 GB');
  });
  it('shows a dash for unknown sizes', () => {
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('scales from sub-millisecond to hours', () => {
    expect(formatDuration(0.42, { lang: 'en' })).toBe('0.42 ms');
    expect(formatDuration(4.25, { lang: 'en' })).toBe('4.3 ms');
    expect(formatDuration(123.4, { lang: 'en' })).toBe('123 ms');
    expect(formatDuration(1234, { lang: 'en' })).toBe('1.23 s');
    expect(formatDuration(1234, { lang: 'tr' })).toBe('1,23 sn');
    expect(formatDuration(12_345, { lang: 'en' })).toBe('12.3 s');
    expect(formatDuration(125_000, { lang: 'en' })).toBe('2m 5s');
    expect(formatDuration(125_000, { lang: 'tr' })).toBe('2 dk 5 sn');
    expect(formatDuration(3_720_000, { lang: 'tr' })).toBe('1 sa 2 dk');
    expect(formatDuration(undefined)).toBe('—');
  });
});

describe('log timestamps', () => {
  const ts = new Date(2026, 10, 2, 14, 5, 12, 345).getTime();
  it('absolute clock time with milliseconds', () => {
    expect(formatClock(ts)).toBe('14:05:12.345');
    expect(formatClock(ts, { ms: false })).toBe('14:05:12');
    expect(formatTime(ts)).toBe('14:05:12.345');
  });
  it('relative and delta offsets', () => {
    expect(formatTime(ts, { format: 'relative', base: ts - 12_345 })).toBe('+12.345');
    expect(formatTime(ts, { format: 'delta', prev: ts - 12 })).toBe('+0.012');
    expect(formatTime(ts, { format: 'delta' })).toBe('+0.000');
    expect(formatOffset(125_007)).toBe('+2:05.007');
    expect(formatOffset(3_725_000)).toBe('+1:02:05.000');
    expect(formatOffset(-1500)).toBe('−1.500');
  });
});

describe('numbers', () => {
  it('formats counts per language', () => {
    expect(formatNumber(12345, { lang: 'tr' })).toBe('12.345');
    expect(formatNumber(12345, { lang: 'en' })).toBe('12,345');
    expect(formatCompact(999, { lang: 'en' })).toBe('999');
    expect(formatCompact(12_345, { lang: 'en' })).toBe('12K');
    expect(formatCompact(4_300, { lang: 'tr' })).toBe('4,3K');
    expect(formatCompact(2_500_000, { lang: 'en' })).toBe('2.5M');
    expect(formatPercent(45.2, { lang: 'tr' })).toBe('%45');
    expect(formatPercent(45.2, { lang: 'en' })).toBe('45%');
  });
});

describe('formatRelative', () => {
  it('uses Intl.RelativeTimeFormat in both languages', () => {
    const now = 1_793_600_000_000;
    expect(formatRelative(now - 2_000, now, { lang: 'en' })).toBe('now');
    expect(formatRelative(now - 2 * 60_000, now, { lang: 'en' })).toBe('2 min. ago');
    expect(formatRelative(now - 2 * 60_000, now, { lang: 'tr' })).toBe('2 dk. önce');
    expect(formatRelative(now - 86_400_000, now, { lang: 'tr' })).toBe('dün');
  });
});
