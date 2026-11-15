import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import { isBannerCrash, isLayoutError, isQuietCrashRecord, mergeCrashes } from './live';

const ts = 1_700_000_000_000;
let nextId = 1;
const crash = (p: Partial<LogEntry> & { message: string }): LogEntry => ({ id: nextId++, ts, deviceId: 'demo:1', source: 'app', level: 'fatal', tag: 't', kind: 'crash', ...p });

describe('mergeCrashes (crash banner list)', () => {
  it('appends new crashes and reports them as fresh', () => {
    const fresh: LogEntry[] = [];
    const a = crash({ message: 'Unhandled exception: a' });
    const list = mergeCrashes([], [a], fresh);
    expect(list).toEqual([a]);
    expect(fresh).toEqual([a]);
  });

  it('counts the app report and the device copy of one crash once, preferring the app copy', () => {
    const dev = crash({ source: 'device', kind: 'flutter-error', level: 'error', message: '══╡ EXCEPTION ╞══\nA RenderFlex overflowed' });
    const app = crash({ source: 'app', kind: 'flutter-error', level: 'error', message: '══╡ EXCEPTION ╞══\nA RenderFlex overflowed' });
    const fresh: LogEntry[] = [];
    const list = mergeCrashes([], [dev, app], fresh);
    expect(list).toEqual([app]);
    expect(fresh).toEqual([dev]); // notified once (for the first copy)
  });

  it('keeps the list identity when nothing changes and caps it at 50', () => {
    const app = crash({ message: 'Unhandled exception: x' });
    const dev = crash({ source: 'device', level: 'error', kind: undefined, message: '[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: x' });
    const list = [app];
    expect(mergeCrashes(list, [dev], [])).toBe(list);
    const many = Array.from({ length: 60 }, (_, i) => crash({ message: `Unhandled exception: n${i}`, ts: ts + i * 10_000 }));
    expect(mergeCrashes([], many, []).length).toBe(50);
  });
});

describe('isLayoutError (a layout overflow is not a crash)', () => {
  const flutter = (message: string, data?: Record<string, unknown>): LogEntry =>
    ({ id: 1, ts: 1, deviceId: 'd', source: 'app', level: 'error', tag: 'flutter', kind: 'flutter-error', message, ...(data ? { data } : {}) }) as LogEntry;

  it('quiets RenderFlex overflows and constraint errors, from the SDK and from the console', () => {
    expect(isLayoutError(flutter('A RenderFlex overflowed by 42 pixels on the right.', { library: 'rendering library' }))).toBe(true);
    expect(isLayoutError(flutter('══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞════\nA RenderFlex overflowed by 8.0 pixels on the bottom.'))).toBe(true);
    expect(isLayoutError(flutter('Vertical viewport was given unbounded height.'))).toBe(true);
    expect(isQuietCrashRecord(flutter('A RenderFlex overflowed by 42 pixels on the right.'))).toBe(true);
  });

  it('keeps real errors loud', () => {
    expect(isLayoutError(flutter("Null check operator used on a null value", { library: 'widgets library' }))).toBe(false);
    expect(isLayoutError({ ...flutter('overflowed by 3 pixels'), kind: 'crash' })).toBe(false);
    expect(isQuietCrashRecord(flutter('Bad state: No element'))).toBe(false);
  });
});

describe('memory kills next to crashes', () => {
  const kill = (data: Record<string, unknown>): LogEntry => ({ id: 1, ts: 1, deviceId: 'd', source: 'device', level: 'error', tag: 'jetsam', message: 'closed', data }) as LogEntry;
  it('the app on screen closed for memory counts for the banner; a background kill does not', () => {
    expect(isBannerCrash(kill({ termination: 'jetsam', frontmost: true }))).toBe(true);
    expect(isBannerCrash(kill({ termination: 'low-memory', visible: true }))).toBe(true);
    expect(isBannerCrash(kill({ termination: 'jetsam', frontmost: false }))).toBe(false);
    expect(isBannerCrash(kill({ termination: 'SIGNAL 11 Segmentation fault' }))).toBe(false);
  });
});
