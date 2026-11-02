import { describe, expect, it } from 'vitest';
import { findJsonPayload, isStackFrameLine, looksLikeStackTrace } from './index';
import { DART_STACK, FLUTTER_BOX, IOS_NATIVE_CRASH, JAVA_CRASH, JSC_FRAMES, JS_FRAMES, NATIVE_TOMBSTONE, SWIFT_FRAMES } from './fixtures.test-data';

describe('findJsonPayload', () => {
  it('finds a payload after a prefix and returns exact bounds', () => {
    const msg = 'Response 200 {"items":[{"id":40,"name":"Pamuk"}],"next":null} in 123ms';
    const r = findJsonPayload(msg)!;
    expect(msg.slice(r.start, r.end)).toBe('{"items":[{"id":40,"name":"Pamuk"}],"next":null}');
    expect(r.value).toEqual({ items: [{ id: 40, name: 'Pamuk' }], next: null });
  });

  it('whole-message JSON objects and arrays', () => {
    expect(findJsonPayload('{"level":"info","msg":"started"}')?.value).toEqual({ level: 'info', msg: 'started' });
    expect(findJsonPayload('[1, 2, 3]')?.value).toEqual([1, 2, 3]);
    expect(findJsonPayload('[{"a":1}]')?.value).toEqual([{ a: 1 }]);
    expect(findJsonPayload('  \n{\n  "pretty": true\n}\n')?.value).toEqual({ pretty: true });
  });

  it('braces and brackets inside strings, escapes and unicode', () => {
    const msg = 'got {"text":"a } tricky ] string with \\"quotes\\" and {braces}","ok":true} done';
    const r = findJsonPayload(msg)!;
    expect(r.value).toEqual({ text: 'a } tricky ] string with "quotes" and {braces}', ok: true });
    expect(msg.slice(r.end)).toBe(' done');
    expect(findJsonPayload('{"şehir":"İstanbul","emoji":"🐾"}')?.value).toEqual({ şehir: 'İstanbul', emoji: '🐾' });
    expect(findJsonPayload('{"path":"C:\\\\tmp\\\\x"}')?.value).toEqual({ path: 'C:\\tmp\\x' });
  });

  it('nested payload after a non-JSON wrapper', () => {
    expect(findJsonPayload('Map{a: {"b":1}}')?.value).toEqual({ b: 1 });
    expect(findJsonPayload('Bundle[{"key":"v"}]')?.value).toEqual([{ key: 'v' }]);
    expect(findJsonPayload('first [x] then {"y":2}')?.value).toEqual({ y: 2 });
  });

  it('rejects things that only look like JSON', () => {
    for (const msg of [
      '',
      'no braces at all',
      '{}',
      '[]',
      '[main]',
      '[ 1234.5678] kernel time',
      '[200]',
      '["single"]',
      '{id: 1, name: Pamuk}', // Dart map toString
      'User(id=1) {name=Ali}', // Kotlin
      'Bundle[{id=1, name=x}]',
      '{"a": 1,}', // trailing comma
      "{'a': 1}", // single quotes
      '{"a": "line\nbreak"}', // raw newline in a string
      'IPv6 [::1]:8080',
    ]) {
      expect(findJsonPayload(msg)).toBeNull();
    }
  });

  it('truncated JSON is not a payload, but a later complete one is', () => {
    expect(findJsonPayload('Response {"items":[1,2,3')).toBeNull();
    expect(findJsonPayload('{"a":1,"b":{"c":[1,2')).toBeNull();
    expect(findJsonPayload('Body (truncated) {"a":[1,2 … then {"ok":true}')?.value).toEqual({ ok: true });
  });

  it('huge lines stay fast and bounded', () => {
    const big = JSON.stringify({ items: Array.from({ length: 15_000 }, (_, i) => ({ id: i, name: `Pet ${i}`, tags: ["a", "b"] })) });
    expect(big.length).toBeGreaterThan(500_000);
    let t0 = performance.now();
    const r = findJsonPayload(`HTTP 200 ${big}`);
    const tBig = performance.now() - t0;
    expect((r?.value as { items: unknown[] }).items.length).toBe(15_000);

    const noise = 'x'.repeat(2_000_000);
    t0 = performance.now();
    expect(findJsonPayload(noise)).toBeNull();
    const tNoise = performance.now() - t0;

    const nested = '['.repeat(200_000); // every candidate is unbalanced: the scan budget stops the work
    t0 = performance.now();
    expect(findJsonPayload(nested)).toBeNull();
    const tNested = performance.now() - t0;

    const manyBrackets = '[INFO] [main] [x] '.repeat(20_000);
    t0 = performance.now();
    expect(findJsonPayload(manyBrackets)).toBeNull();
    const tMany = performance.now() - t0;
    console.info(
      `[bench] findJsonPayload: ${(big.length / 1e6).toFixed(2)} MB JSON ${tBig.toFixed(1)} ms · 2 MB text ${tNoise.toFixed(1)} ms · 200k '[' ${tNested.toFixed(1)} ms · 360 KB of [tags] ${tMany.toFixed(1)} ms`,
    );
    expect(tNoise).toBeLessThan(50);
    expect(tNested).toBeLessThan(250);
    expect(tMany).toBeLessThan(250);
  });

  it('handles non-string input defensively', () => {
    expect(findJsonPayload(undefined as unknown as string)).toBeNull();
  });
});

describe('looksLikeStackTrace', () => {
  it.each([
    ['Java/Kotlin (AndroidRuntime)', JAVA_CRASH],
    ['Dart VM', `Unhandled Exception: Bad state\n${DART_STACK}`],
    ['Dart terse', 'Bad state\npackage:pati/core/api.dart 74:28   PatiApiClient._send\ndart:async/zone.dart 1399:47   _rootRun'],
    ['JS V8/Hermes', JS_FRAMES],
    ['JS JavaScriptCore', JSC_FRAMES],
    ['Swift/ObjC frames', SWIFT_FRAMES],
    ['ObjC first throw call stack', IOS_NATIVE_CRASH],
    ['Android native tombstone', NATIVE_TOMBSTONE],
    ['Flutter engine error', `[ERROR:flutter/runtime/dart_vm_initializer.cc(40)] Unhandled Exception: Null check operator used on a null value\n${DART_STACK}`],
  ])('detects %s', (_name, message) => {
    expect(looksLikeStackTrace({ message })).toBe(true);
  });

  it('error.stack counts when non-empty', () => {
    expect(looksLikeStackTrace({ message: 'Unhandled exception', error: { stack: DART_STACK } })).toBe(true);
    expect(looksLikeStackTrace({ message: 'x', error: { stack: '  ' } })).toBe(false);
    expect(looksLikeStackTrace({ message: 'x', error: { message: 'boom' } })).toBe(false);
  });

  it('ignores ordinary multi-line text', () => {
    for (const message of [
      'single line at com.foo.Bar.baz(Bar.kt:1)',
      FLUTTER_BOX,
      'ANR in com.mykynk.mahalle\nPID: 5120\nReason: Input dispatching timed out',
      'We meet at noon (see below)\nand at the station (platform 2)',
      'Remote config (v87):\n  newCheckout: true\n  maxUploadMB: 10',
      'one frame only\n\tat com.foo.Bar.baz(Bar.kt:1)',
      'Skipped 48 frames!\nThe application may be doing too much work on its main thread.',
    ]) {
      expect(looksLikeStackTrace({ message })).toBe(false);
    }
  });

  it('isStackFrameLine', () => {
    expect(isStackFrameLine('\tat android.os.Looper.loop(Looper.java:317)')).toBe(true);
    expect(isStackFrameLine('#12     SchedulerBinding.handleDrawFrame (package:flutter/src/scheduler/binding.dart:1355:9)')).toBe(true);
    expect(isStackFrameLine('Caused by: java.lang.NullPointerException')).toBe(false);
  });

  it('is cheap on long dumps without frames', () => {
    const dump = Array.from({ length: 5000 }, (_, i) => `│ ├PetCard(pet: Pamuk ${i})`).join('\n');
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) looksLikeStackTrace({ message: dump });
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
