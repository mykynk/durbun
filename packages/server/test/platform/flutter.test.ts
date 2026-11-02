import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceLogInput } from '../../src/types';
import {
  classifyFlutterLine,
  flutterEngineLevel,
  FlutterErrorGrouper,
  isFlutterBoxEnd,
  stripFlutterPrefix,
} from '../../src/platform/shared/flutter';
import { LogBatcher } from '../../src/platform/shared/batcher';
import { silentLogger } from '../../src/util/logger';

const BOX = [
  '══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞═══════════════════════════════════════════════════════════',
  'The following _TypeError was thrown building MyHomePage(dirty, state: _MyHomePageState#d2a5c):',
  "type 'Null' is not a subtype of type 'String'",
  '',
  'The relevant error-causing widget was:',
  '  MyHomePage MyHomePage:file:///Users/yusuf/pati/lib/main.dart:23:13',
  '',
  'When the exception was thrown, this was the stack:',
  '#0      _MyHomePageState.build (package:pati/main.dart:41:24)',
  '#1      StatefulElement.build (package:flutter/src/widgets/framework.dart:5729:27)',
  '════════════════════════════════════════════════════════════════════════════════════════════════════',
];

const f = (message: string, pid = 100, ts = 1): DeviceLogInput => ({ ts, pid, level: 'info', tag: 'flutter', message });

describe('flutter helpers', () => {
  it('detects the closing rule and engine lines', () => {
    expect(isFlutterBoxEnd(BOX.at(-1)!)).toBe(true);
    expect(isFlutterBoxEnd(BOX[0]!)).toBe(false);
    expect(isFlutterBoxEnd('═══')).toBe(false);
    expect(flutterEngineLevel('[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: x')).toBe('error');
    expect(flutterEngineLevel('[FATAL:flutter/shell/common/shell.cc(93)] Check failed')).toBe('fatal');
    expect(flutterEngineLevel('[VERBOSE-2:shell.cc(93)] x')).toBeUndefined();
    expect(flutterEngineLevel('[IMPORTANT:flutter/shell/platform/android/android_context_vk_impeller.cc(62)] Using the Impeller rendering backend (Vulkan).')).toBe('info');
  });

  it('strips the iOS "flutter: " prefix', () => {
    expect(stripFlutterPrefix('flutter: hello')).toBe('hello');
    expect(stripFlutterPrefix('flutter:')).toBe('');
    expect(stripFlutterPrefix('flutterx: no')).toBeNull();
  });

  it('classifies "Another exception" and Dart unhandled exceptions', () => {
    expect(classifyFlutterLine(f('Another exception was thrown: RenderFlex overflowed'))).toMatchObject({
      kind: 'flutter-error',
      level: 'error',
    });
    expect(
      classifyFlutterLine(f('[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: Bad state: x')),
    ).toMatchObject({ kind: 'crash', level: 'error' });
    expect(classifyFlutterLine(f('just a print')).kind).toBeUndefined();
  });
});

describe('FlutterErrorGrouper', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('groups one-line-per-record boxes and passes other processes through immediately', () => {
    const out: DeviceLogInput[] = [];
    const g = new FlutterErrorGrouper((e) => out.push(e));
    BOX.slice(0, 5).forEach((l, i) => g.push(f(l, 100, 10 + i)));
    g.push({ ts: 20, pid: 200, level: 'info', tag: 'flutter', message: 'other app print' });
    g.push({ ts: 21, pid: 100, level: 'debug', tag: 'OpenGLRenderer', message: 'same pid, other tag' });
    BOX.slice(5).forEach((l, i) => g.push(f(l, 100, 30 + i)));
    expect(out.map((e) => e.message)).toEqual(['other app print', 'same pid, other tag', BOX.join('\n')]);
    expect(out[2]).toMatchObject({ kind: 'flutter-error', level: 'error', ts: 10, pid: 100 });
    expect(g.openBoxes).toBe(0);
  });

  it('handles a whole box arriving as one multi-line record', () => {
    const out: DeviceLogInput[] = [];
    const g = new FlutterErrorGrouper((e) => out.push(e));
    g.push(f(BOX.join('\n')));
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('flutter-error');
  });

  it('flushes an unterminated box after the idle window (debugPrint throttling safe)', () => {
    const out: DeviceLogInput[] = [];
    const g = new FlutterErrorGrouper((e) => out.push(e), { idleFlushMs: 2500 });
    g.push(f(BOX[0]!));
    vi.advanceTimersByTime(1200);
    g.push(f(BOX[1]!));
    vi.advanceTimersByTime(2000);
    expect(out).toHaveLength(0);
    vi.advanceTimersByTime(600);
    expect(out).toHaveLength(1);
    expect(out[0]!.message.split('\n')).toHaveLength(2);
  });

  it('closes the previous box when a new one starts', () => {
    const out: DeviceLogInput[] = [];
    const g = new FlutterErrorGrouper((e) => out.push(e));
    g.push(f(BOX[0]!));
    g.push(f(BOX[1]!));
    g.push(f(BOX[0]!));
    expect(out).toHaveLength(1);
    g.flushAll();
    expect(out).toHaveLength(2);
  });
});

describe('LogBatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('batches within ~50 ms and flushes immediately at the size limit', () => {
    const batches: number[] = [];
    const b = new LogBatcher((entries) => batches.push(entries.length), silentLogger, 50, 3);
    b.push(f('a'));
    b.push(f('b'));
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(batches).toEqual([2]);
    b.push(f('c'));
    b.push(f('d'));
    b.push(f('e'));
    expect(batches).toEqual([2, 3]);
    b.push(f('f'));
    b.dispose();
    expect(batches).toEqual([2, 3, 1]);
    b.push(f('ignored'));
    vi.advanceTimersByTime(100);
    expect(batches).toEqual([2, 3, 1]);
  });

  it('never throws when the hub rejects a batch', () => {
    const b = new LogBatcher(() => {
      throw new Error('hub down');
    }, silentLogger);
    b.push(f('a'));
    expect(() => b.flush()).not.toThrow();
  });
});
