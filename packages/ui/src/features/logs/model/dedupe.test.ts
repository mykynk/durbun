import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import { crashSignature, dedupeHash, dedupeText, isMarkedDuplicate, isTwinPair, sameDedupeText, signatureHash } from './dedupe';

const entry = (p: Partial<LogEntry> & { message: string }): LogEntry => ({ id: 1, ts: 1_700_000_000_000, deviceId: 'demo:1', source: 'device', level: 'info', tag: 't', ...p });

describe('dedupe text', () => {
  it('ignores a leading "flutter: " and trailing whitespace', () => {
    expect(dedupeText('flutter: hello  \n')).toBe('hello');
    expect(sameDedupeText('flutter: hello', 'hello\n')).toBe(true);
    expect(sameDedupeText('hello', 'hello!')).toBe(false);
    expect(dedupeHash({ message: 'flutter: hello' })).toBe(dedupeHash({ message: 'hello ' }));
  });
});

describe('crashSignature', () => {
  it('Flutter SDK crash and engine line share the unhandled-exception text', () => {
    const app = entry({ source: 'app', kind: 'crash', level: 'fatal', message: 'Unhandled exception: Bad state: No element', error: { type: 'StateError', message: 'Bad state: No element' } });
    const dev = entry({ source: 'device', level: 'error', tag: 'flutter', message: '[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: Bad state: No element\n#0      main (package:pati/main.dart:3:1)' });
    expect(crashSignature(app)).toBe('u:Bad state: No element');
    expect(crashSignature(dev)).toBe(crashSignature(app));
  });

  it('Android: SDK error type = the exception class of the FATAL EXCEPTION group', () => {
    const app = entry({ source: 'app', kind: 'crash', message: 'FATAL EXCEPTION in thread "main": java.lang.NullPointerException: boom', error: { type: 'java.lang.NullPointerException', message: 'boom' } });
    const dev = entry({ kind: 'crash', message: 'FATAL EXCEPTION: main\nProcess: com.example, PID: 1\njava.lang.NullPointerException: boom\n\tat com.example.Main.run(Main.kt:3)' });
    expect(crashSignature(app)).toBe('c:java.lang.NullPointerException');
    expect(crashSignature(dev)).toBe('c:java.lang.NullPointerException');
    // no error object: the class is read from the first line
    expect(crashSignature({ ...app, error: undefined })).toBe('c:java.lang.NullPointerException');
  });

  it('iOS: NSException name from the terminating line', () => {
    const dev = entry({ kind: 'crash', message: "*** Terminating app due to uncaught exception 'NSInvalidArgumentException', reason: '-[__NSCFString objectForKey:]'" });
    const app = entry({ source: 'app', kind: 'crash', message: 'NSInvalidArgumentException: -[__NSCFString objectForKey:]', error: { type: 'NSInvalidArgumentException' } });
    expect(crashSignature(dev)).toBe('c:NSInvalidArgumentException');
    expect(crashSignature(app)).toBe('c:NSInvalidArgumentException');
  });

  it('is null for ordinary lines, system lines and previous-launch reports', () => {
    expect(crashSignature(entry({ message: 'Unhandled exception: x' }))).toBeNull(); // not a crash, not an engine line
    expect(crashSignature(entry({ source: 'system', kind: 'crash', message: 'Unhandled exception: x' }))).toBeNull();
    expect(crashSignature(entry({ source: 'app', kind: 'crash', message: 'Crash in previous launch: SIGSEGV', data: { previousLaunch: true } }))).toBeNull();
    expect(crashSignature(entry({ source: 'app', kind: 'crash', message: 'Previous launch crashed — java.lang.X: y' }))).toBeNull();
  });

  it('hashes signatures deterministically', () => {
    expect(signatureHash('u:a')).toBe(signatureHash('u:a'));
    expect(signatureHash('u:a')).not.toBe(signatureHash('u:b'));
    expect(signatureHash('u:a')).toBeGreaterThanOrEqual(0);
  });
});

describe('isTwinPair', () => {
  const ts = 1_700_000_000_000;
  it('matches app/device copies of the same line or crash on one device within ±2 s', () => {
    expect(isTwinPair(entry({ source: 'app', message: 'hi', ts }), entry({ message: 'flutter: hi', ts: ts + 1500 }))).toBe(true);
    expect(isTwinPair(entry({ source: 'app', message: 'hi', ts }), entry({ message: 'hi', ts: ts + 2500 }))).toBe(false);
    expect(isTwinPair(entry({ source: 'app', message: 'hi', ts }), entry({ source: 'app', message: 'hi', ts }))).toBe(false);
    expect(isTwinPair(entry({ source: 'app', message: 'hi', ts }), entry({ message: 'hi', ts, deviceId: 'demo:2' }))).toBe(false);
    const crash = entry({ source: 'app', kind: 'crash', message: 'Unhandled exception: x', ts });
    expect(isTwinPair(crash, entry({ tag: 'flutter', message: '[ERROR:flutter/lib/ui/ui_dart_state.cc(198)] Unhandled Exception: x', ts }))).toBe(true);
    expect(isTwinPair(crash, entry({ tag: 'flutter', message: '[ERROR:flutter/lib/ui/ui_dart_state.cc(198)] Unhandled Exception: y', ts }))).toBe(false);
  });
});

describe('isMarkedDuplicate (device crash records matched by the server)', () => {
  it('reads data.duplicateOf as a number or a non-empty string', () => {
    expect(isMarkedDuplicate({ data: { origin: 'dropbox', package: 'com.mykynk.kumbara', duplicateOf: 48121 } })).toBe(true);
    expect(isMarkedDuplicate({ data: { origin: 'crash-report', duplicateOf: '48121' } })).toBe(true);
    expect(isMarkedDuplicate({ data: { origin: 'dropbox', duplicateOf: null } })).toBe(false);
    expect(isMarkedDuplicate({ data: { origin: 'dropbox', duplicateOf: '' } })).toBe(false);
    expect(isMarkedDuplicate({ data: 'duplicateOf' })).toBe(false);
    expect(isMarkedDuplicate({})).toBe(false);
  });
});
