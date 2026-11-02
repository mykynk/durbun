import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@durbun/protocol';
import { analyzeEntry, crashSummary, isDumpText, jsonPreview } from './analyze';

let id = 0;
const entry = (partial: Partial<LogEntry> & { message: string }): LogEntry => ({ id: ++id, ts: 1_700_000_000_000, deviceId: 'demo:1', source: 'device', level: 'info', tag: 't', ...partial });

const FLUTTER_BOX = `══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞═════════════════════════
The following assertion was thrown during layout:
A RenderFlex overflowed by 38 pixels on the right.

The relevant error-causing widget was:
  Row Row:file:///Users/deniz/dev/pati/lib/features/pets/widgets/pet_card.dart:57:16
════════════════════════════════════════════════════════════════════`;

const DEVICE_JAVA_CRASH = `FATAL EXCEPTION: main
Process: com.mykynk.mahalle, PID: 4821
java.lang.IllegalStateException: Fragment BasketFragment{4a1c2e9} not attached to a context.
	at androidx.fragment.app.Fragment.requireContext(Fragment.java:972)
	at com.mykynk.mahalle.ui.basket.BasketFragment.renderTotals(BasketFragment.kt:214)`;

describe('analyzeEntry: headlines and folding', () => {
  it('uses the first line and counts the folded lines', () => {
    const a = analyzeEntry(entry({ message: 'line 1\nline 2\nline 3' }));
    expect(a.headline).toBe('line 1');
    expect(a.lines).toBe(3);
    expect(a.extra).toBe(2);
    expect(a.stack).toBeNull();
  });

  it('ignores a trailing newline', () => {
    const a = analyzeEntry(entry({ message: 'only\n' }));
    expect(a.extra).toBe(0);
  });

  it('detects stack traces in the message and counts frames', () => {
    const a = analyzeEntry(entry({ message: 'java.net.SocketTimeoutException: timeout\n\tat okhttp3.A.b(A.kt:1)\n\tat okhttp3.C.d(C.kt:2)\n\tat java.lang.Thread.run(Thread.java:1012)' }));
    expect(a.headline).toBe('java.net.SocketTimeoutException: timeout');
    expect(a.frames).toBe(3);
    expect(a.stack).toContain('okhttp3.A.b');
  });

  it('uses error.stack when present', () => {
    const a = analyzeEntry(entry({ source: 'app', message: 'Ödeme başarısız', error: { type: 'StateError', message: 'x', stack: '#0      PaymentService.charge (package:pati/core/payment/payment_service.dart:88:7)\n#1      main (package:pati/main.dart:3:1)' } }));
    expect(a.frames).toBe(2);
    expect(a.headline).toBe('Ödeme başarısız');
  });

  it('folds dumps to their first line without calling them stack traces', () => {
    const tree = 'Widget tree (12 lines)\n[root]\n └View\n  └RawView\n   └PatiApp';
    expect(isDumpText(tree)).toBe(true);
    const a = analyzeEntry(entry({ message: tree, tag: 'flutter' }));
    expect(a.dump).toBe(true);
    expect(a.stack).toBeNull();
    expect(a.headline).toBe('Widget tree (12 lines)');
    expect(a.extra).toBe(4);
    expect(isDumpText('Thread dump · 14 threads\n"main" prio=5\n\tat a.b(C.java:1)')).toBe(true);
  });
});

describe('analyzeEntry: JSON payloads', () => {
  it('prefers the structured data of app logs', () => {
    const a = analyzeEntry(entry({ source: 'app', message: 'Kullanıcı giriş yaptı', data: { userId: 42, method: 'email' } }));
    expect(a.json?.fromData).toBe(true);
    expect(a.headline).toBe('Kullanıcı giriş yaptı');
  });

  it('finds JSON in the message and shows the text before it as the headline', () => {
    const a = analyzeEntry(entry({ message: 'Response: {"id":1,"items":[1,2,3]}' }));
    expect(a.json?.fromData).toBe(false);
    expect(a.json?.value).toEqual({ id: 1, items: [1, 2, 3] });
    expect(a.headline).toBe('Response:');
    expect(a.extra).toBe(0);
  });

  it('treats a pretty-printed JSON message as one row', () => {
    const a = analyzeEntry(entry({ message: '{\n  "a": 1,\n  "b": [true, null]\n}' }));
    expect(a.json?.value).toEqual({ a: 1, b: [true, null] });
    expect(a.headline).toBe('');
    expect(a.extra).toBe(0);
  });

  it('builds compact previews', () => {
    expect(jsonPreview({ userId: 42, items: [1, 2, 3], name: 'Ali' })).toBe('{ userId: 42, items: [3], name: "Ali" }');
    expect(jsonPreview({ nested: { a: 1 }, 'content-type': 'json' })).toBe('{ nested: {…}, "content-type": "json" }');
    expect(jsonPreview([1, 2, 3])).toBe('[ 1, 2, 3 ]');
    expect(jsonPreview({})).toBe('{}');
    const long = jsonPreview({ a: 'x'.repeat(30), b: 'y'.repeat(30), c: 'z'.repeat(30), d: 1 }, 72);
    expect(long.endsWith(', … }')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(80);
  });
});

describe('crash headlines (SPEC §9.4)', () => {
  it('Flutter error box → error.message, else the summary line after "The following …"', () => {
    const withError = crashSummary(entry({ source: 'app', kind: 'flutter-error', level: 'error', message: FLUTTER_BOX, error: { type: 'FlutterError', message: 'A RenderFlex overflowed by 38 pixels on the right.' } }));
    expect(withError.title).toBe('A RenderFlex overflowed by 38 pixels on the right.');
    expect(withError.detail).toBe('Rendering Library');
    const deviceCopy = crashSummary(entry({ kind: 'flutter-error', level: 'error', message: FLUTTER_BOX }));
    expect(deviceCopy.title).toBe('A RenderFlex overflowed by 38 pixels on the right.');
    const another = crashSummary(entry({ kind: 'flutter-error', level: 'error', message: 'Another exception was thrown: A RenderFlex overflowed by 38 pixels on the right.' }));
    expect(another.title).toBe('A RenderFlex overflowed by 38 pixels on the right.');
  });

  it('Android device crash → the exception line with the thread', () => {
    const s = crashSummary(entry({ kind: 'crash', level: 'fatal', tag: 'AndroidRuntime', message: DEVICE_JAVA_CRASH }));
    expect(s.title).toBe('java.lang.IllegalStateException: Fragment BasketFragment{4a1c2e9} not attached to a context.');
    expect(s.detail).toBe('thread main');
  });

  it('Android SDK crash → the throwable after the thread name', () => {
    const s = crashSummary(entry({ source: 'app', kind: 'crash', level: 'fatal', message: 'FATAL EXCEPTION in thread "main": java.lang.NullPointerException: boom' }));
    expect(s.title).toBe('java.lang.NullPointerException: boom');
    expect(s.detail).toBe('thread main');
  });

  it('iOS uncaught exception → "Name: reason"', () => {
    const s = crashSummary(
      entry({
        kind: 'crash',
        level: 'fatal',
        tag: 'Runner',
        message: "*** Terminating app due to uncaught exception 'NSInvalidArgumentException', reason: '-[__NSCFString objectForKey:]: unrecognized selector'\n*** First throw call stack:",
      }),
    );
    expect(s.title).toBe('NSInvalidArgumentException: -[__NSCFString objectForKey:]: unrecognized selector');
  });

  it('Flutter engine line → "Unhandled Exception: …"', () => {
    const s = crashSummary(entry({ kind: 'crash', level: 'error', message: '[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: Null check operator used on a null value\n#0 a (package:pati/a.dart:1:1)' }));
    expect(s.title).toBe('Unhandled Exception: Null check operator used on a null value');
  });

  it('previous-launch crashes are labelled and keep their message', () => {
    const ios = crashSummary(entry({ source: 'app', kind: 'crash', level: 'fatal', message: 'Crash in previous launch: EXC_BAD_ACCESS — invalid memory access', data: { previousLaunch: true } }));
    expect(ios.previousLaunch).toBe(true);
    expect(ios.title).toBe('EXC_BAD_ACCESS — invalid memory access');
    const android = crashSummary(entry({ source: 'app', kind: 'crash', level: 'fatal', message: 'Previous launch crashed — FATAL EXCEPTION in thread "main": java.lang.IllegalStateException: x', data: { previousLaunch: true } }));
    expect(android.previousLaunch).toBe(true);
    expect(android.title).toBe('java.lang.IllegalStateException: x');
  });

  it('ANR → package + reason', () => {
    const s = crashSummary(
      entry({
        kind: 'anr',
        level: 'error',
        tag: 'ActivityManager',
        message: 'ANR in com.mykynk.mahalle (com.mykynk.mahalle/.ui.MainActivity)\nPID: 4821\nReason: Input dispatching timed out (Waited 5001ms)',
      }),
    );
    expect(s.title).toBe('ANR in com.mykynk.mahalle');
    expect(s.detail).toBe('Input dispatching timed out (Waited 5001ms)');
  });

  it('Dart zone crash from the SDK keeps its message as the headline', () => {
    const a = analyzeEntry(entry({ source: 'app', kind: 'crash', level: 'fatal', message: 'Unhandled exception: Null check operator used on a null value', error: { stack: '#0 a (package:pati/a.dart:1:1)\n#1 b (package:flutter/b.dart:2:2)' } }));
    expect(a.headline).toBe('Unhandled exception: Null check operator used on a null value');
    expect(a.frames).toBe(2);
  });
});
