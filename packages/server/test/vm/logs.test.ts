import { readFileSync } from 'node:fs';
import type { SdkLog } from '@durbun/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  displayClassName,
  instanceText,
  loggingEventKey,
  loggingEventToAppLog,
  type AppLog,
  type LoggingEventJson,
  type ObjectResolver,
} from '../../src/platform/flutterVm/logRecord';
import { FlutterErrorGrouper, LineAssembler, StdioPipeline, type GroupedLine } from '../../src/platform/flutterVm/stdio';

/** Recorded `Logging` events (Dart 3.10): tick (800), debug (500), long truncated (900), error (1000), level-less. */
const events = (
  JSON.parse(readFileSync(new URL('./fixtures/logging-events.json', import.meta.url), 'utf8')) as { event: LoggingEventJson }[]
).map((e) => e.event);
const stdio = JSON.parse(readFileSync(new URL('./fixtures/stdio-events.json', import.meta.url), 'utf8')) as {
  streamId: 'Stdout' | 'Stderr';
  event: { bytes: string; timestamp: number };
}[];
const [tickEv, debugEv, longEv, errorEv, plainEv] = events;

function fakeResolver(): ObjectResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fullString: async (_iso, objectId, maxChars) => {
      calls.push(`getObject ${objectId} ${maxChars}`);
      return `${'long payload '.repeat(20)}end 7`;
    },
    describe: async (_iso, objectId) => {
      calls.push(`invoke ${objectId}`);
      return 'FormatException: bad input 7';
    },
  };
}

describe('Logging events → app logs (recorded)', () => {
  const opts = { maxChars: 256 * 1024 };

  it('maps level and logger name, uses the record time', async () => {
    const log = (await loggingEventToAppLog(tickEv!, fakeResolver(), opts))!;
    expect(log).toMatchObject({ level: 'info', tag: 'fixture.tick', kind: 'text' });
    expect(log.message).toMatch(/^tick \d+$/);
    expect(log.ts).toBe(tickEv!.logRecord!.time);
    expect(log.error).toBeUndefined();
    expect((await loggingEventToAppLog(debugEv!, undefined, opts))!.level).toBe('debug');
  });

  it('fetches the full text of messages the VM truncated to 128 chars', async () => {
    expect(longEv!.logRecord!.message!.valueAsStringIsTruncated).toBe(true);
    const resolver = fakeResolver();
    const log = (await loggingEventToAppLog(longEv!, resolver, opts))!;
    expect(log.level).toBe('warn');
    expect(log.message.endsWith('end 7')).toBe(true);
    expect(resolver.calls).toEqual([`getObject ${longEv!.logRecord!.message!.id} ${opts.maxChars}`]);
    // Without a resolver (log flood) the preview is kept and marked as cut.
    const fast = (await loggingEventToAppLog(longEv!, undefined, opts))!;
    expect(fast.message.endsWith('…')).toBe(true);
    expect(fast.message.length).toBe(129);
  });

  it('turns error objects into ErrorInfo (toString via invoke, stack trace text)', async () => {
    const resolver = fakeResolver();
    const log = (await loggingEventToAppLog(errorEv!, resolver, opts))!;
    expect(log.level).toBe('error');
    expect(log.tag).toBe('fixture.error');
    expect(log.message).toMatch(/^parse failed \d+$/);
    expect(log.error).toEqual({
      type: 'FormatException',
      message: 'FormatException: bad input 7',
      stack: expect.stringMatching(/^#0 {6}main\.<anonymous closure> \(file:\/\/\/.*app\.dart:\d+:\d+\)/),
    });
    expect(log.error!.stack!.endsWith('\n')).toBe(false);
    expect(resolver.calls).toEqual([`invoke ${errorEv!.logRecord!.error!.id}`]);
  });

  it('level-less developer.log() is info with the default "log" tag', async () => {
    const log = (await loggingEventToAppLog(plainEv!, undefined, opts))!;
    expect(log).toMatchObject({ level: 'info', tag: 'log' });
    expect(log.message).toMatch(/^plain log without level \d+$/);
  });

  it('a level-less log with an error is an error; string errors keep no type', async () => {
    const ev = structuredClone(plainEv!);
    ev.logRecord!.error = { type: '@Instance', kind: 'String', id: 'objects/1/0', class: { name: '_OneByteString' }, valueAsString: 'boom' };
    const log = (await loggingEventToAppLog(ev, undefined, opts))!;
    expect(log.level).toBe('error');
    expect(log.error).toEqual({ message: 'boom' });
  });

  it('survives resolver failures and missing records', async () => {
    const failing: ObjectResolver = {
      fullString: async () => {
        throw new Error('expired');
      },
      describe: async () => {
        throw new Error('isolate paused');
      },
    };
    const log = (await loggingEventToAppLog(errorEv!, failing, opts))!;
    expect(log.error?.message).toBe("Instance of 'FormatException'");
    expect(await loggingEventToAppLog({ kind: 'Logging' }, failing, opts)).toBeUndefined();
    expect(await instanceText({ kind: 'Null' }, 'i', failing, 10)).toBeUndefined();
  });

  it('event keys identify replays', () => {
    expect(loggingEventKey(tickEv!)).toBe(loggingEventKey(structuredClone(tickEv!)));
    expect(loggingEventKey(tickEv!)).not.toBe(loggingEventKey(debugEv!));
  });

  it('cleans private class names', () => {
    expect(displayClassName('_Exception')).toBe('Exception');
    expect(displayClassName('FormatException')).toBe('FormatException');
    expect(displayClassName('_')).toBe('_');
    expect(displayClassName(undefined)).toBeUndefined();
  });
});

describe('stdout / stderr assembly', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('joins chunks into lines like the recorded WriteEvents ("partial " + print)', () => {
    const lines: string[] = [];
    const out = new LineAssembler((l) => lines.push(l.text));
    for (const e of stdio.filter((s) => s.streamId === 'Stdout')) {
      out.push(Buffer.from(e.event.bytes, 'base64').toString('utf8'), e.event.timestamp);
    }
    expect(lines).toEqual(['partial printed line 1', 'partial printed line 2']);
  });

  it('splits multi-line chunks, strips CR, flushes an unterminated tail after a pause', () => {
    vi.useFakeTimers();
    const lines: { text: string; ts: number }[] = [];
    const a = new LineAssembler((l) => lines.push(l), 100);
    a.push('a\r\nb\nc', 1);
    expect(lines).toEqual([
      { text: 'a', ts: 1 },
      { text: 'b', ts: 1 },
    ]);
    a.push('d', 2);
    vi.advanceTimersByTime(99);
    expect(lines).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(lines[2]).toEqual({ text: 'cd', ts: 1 });
  });

  it('folds a Flutter error box into one entry', () => {
    const out: GroupedLine[] = [];
    const g = new FlutterErrorGrouper((l) => out.push(l));
    const box = [
      '══╡ EXCEPTION CAUGHT BY WIDGETS LIBRARY ╞═══════════════════════════════════════════════════════════',
      'The following assertion was thrown building MyHomePage(dirty):',
      'A RenderFlex overflowed by 42 pixels on the right.',
      '',
      'When the exception was thrown, this was the stack:',
      '#0      RenderFlex.performLayout (package:flutter/src/rendering/flex.dart:1081:7)',
      '════════════════════════════════════════════════════════════════════════════════════════════════════',
    ];
    g.push({ text: 'before', ts: 1 });
    for (const [i, text] of box.entries()) g.push({ text, ts: 10 + i });
    g.push({ text: 'Another exception was thrown: A RenderFlex overflowed by 42 pixels on the right.', ts: 30 });
    g.push({ text: 'after', ts: 31 });
    expect(out.map((l) => [l.text.split('\n')[0], !!l.flutterError])).toEqual([
      ['before', false],
      [box[0], true],
      ['Another exception was thrown: A RenderFlex overflowed by 42 pixels on the right.', true],
      ['after', false],
    ]);
    expect(out[1]!.text.split('\n')).toHaveLength(box.length);
    expect(out[1]!.ts).toBe(10);
  });

  it('closes an unterminated box after silence', () => {
    vi.useFakeTimers();
    const out: GroupedLine[] = [];
    const g = new FlutterErrorGrouper((l) => out.push(l), { idleMs: 500 });
    g.push({ text: '══╡ EXCEPTION CAUGHT BY SCHEDULER LIBRARY ╞══════', ts: 1 });
    g.push({ text: 'oops', ts: 2 });
    vi.advanceTimersByTime(499);
    expect(out).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(out).toEqual([{ text: '══╡ EXCEPTION CAUGHT BY SCHEDULER LIBRARY ╞══════\noops', ts: 1, flutterError: true }]);
  });

  it('pipeline: Flutter apps get the flutter tag without the "flutter: " prefix; plain Dart keeps stdout/stderr', () => {
    const logs: AppLog[] = [];
    let flutter = true;
    const out = new StdioPipeline({ stream: 'stdout', isFlutter: () => flutter, emit: (l) => logs.push(l) });
    const err = new StdioPipeline({ stream: 'stderr', isFlutter: () => flutter, emit: (l) => logs.push(l) });
    out.push('flutter: Kullanıcı giriş yaptı\n', 5);
    out.push('\n', 6); // empty lines are noise
    flutter = false;
    out.push('server on 8080\n', 7);
    err.push('Unhandled exception:\n', 8);
    const plain = logs.map((l) => ({ tag: l.tag, level: l.level, message: l.message, kind: l.kind }));
    expect(plain).toEqual([
      { tag: 'flutter', level: 'info', message: 'Kullanıcı giriş yaptı', kind: 'text' },
      { tag: 'stdout', level: 'info', message: 'server on 8080', kind: 'text' },
      { tag: 'stderr', level: 'error', message: 'Unhandled exception:', kind: 'text' },
    ]);
    const log: SdkLog = { type: 'log', ...logs[0]! };
    expect(log.ts).toBe(5);
  });

  it('pipeline: Flutter error boxes printed line by line become one flutter-error entry', () => {
    const logs: AppLog[] = [];
    const out = new StdioPipeline({ stream: 'stdout', isFlutter: () => true, emit: (l) => logs.push(l) });
    out.push('flutter: ══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞═════════════════\n', 1);
    out.push('flutter: A RenderFlex overflowed by 12 pixels on the bottom.\n', 2);
    out.push('flutter: ═══════════════════════════════════════════════════\n', 3);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'error', kind: 'flutter-error', tag: 'flutter', ts: 1 });
    expect(logs[0]!.message.split('\n')).toHaveLength(3);
  });
});
