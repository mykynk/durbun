import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import { mergeCrashes } from './live';

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
