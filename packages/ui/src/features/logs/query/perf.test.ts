/**
 * Benchmark: 200 000 realistic entries × typical queries must filter in < 50 ms (compile + full scan).
 * Entries go through JSON.parse like wire data (no interned literals), with the demo's mix of noisy
 * logcat lines, SDK logs, JSON payloads, network rows, crashes and stack traces.
 */
import { describe, expect, it } from 'vitest';
import type { LogEntry, LogLevel } from '@durbun/protocol';
import { compileLogQuery, findJsonPayload, looksLikeStackTrace, parseLogQuery } from './index';
import { APPS, DART_STACK, JAVA_CRASH, NOW } from './fixtures.test-data';

const N = 200_000;

function buildEntries(): LogEntry[] {
  let seed = 42;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const deviceTags = ['ActivityManager', 'chatty', 'OpenGLRenderer', 'ViewRootImpl', 'Choreographer', 'InputMethodManager', 'WindowManager', 'BufferQueueProducer', 'SurfaceFlinger', 'GmsClient', 'OkHttp', 'flutter', 'NetworkMonitor', 'BluetoothAdapter'];
  const processes = ['system_server', 'com.android.systemui', 'com.google.android.gms', 'surfaceflinger', 'com.mykynk.pati', 'com.mykynk.mahalle', 'com.mykynk.pati:remote'];
  const appTags = ['api', 'auth', 'router', 'dio', 'cache', 'image', 'payment', 'durbun'];
  const levels: LogLevel[] = ['verbose', 'debug', 'debug', 'info', 'info', 'info', 'info', 'warn', 'error', 'fatal'];
  const words = 'Choreographer Skipped frames application doing too much work main thread Relayout returned old new Davey duration ms Connection reset timeout timed out GET POST https api pati app v1 pets page Kullanıcı giriş yaptı İstanbul Kadıköy sepet güncellendi binder transaction failed waiting for vsync'.split(' ');
  const rows: unknown[] = [];
  for (let i = 0; i < N; i++) {
    const r = rnd();
    const ts = NOW - Math.floor(rnd() * 30 * 60_000);
    const sentence = Array.from({ length: 6 + Math.floor(rnd() * 14) }, () => pick(words)).join(' ');
    if (r < 0.6) {
      const process = pick(processes);
      rows.push({ id: i + 1, ts, deviceId: rnd() < 0.7 ? 'demo:1' : 'demo:2', source: 'device', level: pick(levels), tag: pick(deviceTags), process, pid: 1000 + Math.floor(rnd() * 9000), message: sentence });
    } else if (r < 0.88) {
      const json = rnd() < 0.15;
      const message = json ? `Response 200 {"items":[{"id":${i},"name":"Pamuk","city":"İstanbul"}],"next":"c${i}"}` : sentence;
      rows.push({ id: i + 1, ts, deviceId: 'demo:1', appId: pick(['app:1', 'app:2', 'app:3']), source: 'app', level: pick(levels), tag: pick(appTags), message, data: rnd() < 0.1 ? { userId: i } : undefined });
    } else if (r < 0.95) {
      rows.push({ id: i + 1, ts, deviceId: 'demo:1', appId: 'app:1', source: 'app', level: 'info', tag: 'network', kind: 'network', netId: `app:1:${i}`, message: `GET https://api.pati.app/v1/pets?page=${i % 40}` });
    } else if (r < 0.97) {
      rows.push({ id: i + 1, ts, deviceId: 'demo:1', source: 'device', level: 'fatal', tag: 'AndroidRuntime', process: 'com.mykynk.mahalle', pid: 5120, kind: rnd() < 0.8 ? 'crash' : 'anr', message: JAVA_CRASH });
    } else if (r < 0.985) {
      rows.push({ id: i + 1, ts, deviceId: 'demo:1', appId: 'app:1', source: 'app', level: 'error', tag: 'zone', kind: 'crash', message: 'Unhandled exception: Null check operator used on a null value', error: { message: 'Null check operator used on a null value', stack: DART_STACK } });
    } else {
      rows.push({ id: i + 1, ts, deviceId: '', source: 'system', level: 'info', tag: 'durbun', kind: rnd() < 0.5 ? 'marker' : 'lifecycle', code: 'app.connected', params: { app: 'Pati' }, message: `Pati connected ${i}` });
    }
  }
  return JSON.parse(JSON.stringify(rows)) as LogEntry[];
}

const QUERIES = [
  'level:error tag:dio',
  'is:crash | is:anr',
  '-tag:chatty age:5m',
  'app:Pati "connection reset"',
  'timeout',
  '"connection reset"',
  '(tag:okhttp | tag:dio) level:warn',
  'message~:time(d )?out',
  'tag~:^(Ok|Dio)',
  'is:json',
  'is:stacktrace',
  'is:flutter -level:debug',
  '-tag:chatty -tag:OpenGLRenderer -process:system_server level:info',
  'istanbul',
];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

describe('performance (200 000 entries)', () => {
  const entries = buildEntries();

  it.each(QUERIES)('%s filters in < 50 ms', (q) => {
    const run = () => {
      const t0 = performance.now();
      const c = compileLogQuery(parseLogQuery(q), { now: NOW, apps: APPS });
      let n = 0;
      for (let i = 0; i < entries.length; i++) if (c.test(entries[i]!)) n++;
      return { ms: performance.now() - t0, n };
    };
    run(); // warm-up (JIT)
    const times: number[] = [];
    let n = 0;
    for (let r = 0; r < 5; r++) {
      const res = run();
      times.push(res.ms);
      n = res.n;
    }
    const ms = median(times);
    console.info(`[bench] ${q.padEnd(64)} ${ms.toFixed(1).padStart(6)} ms  (${n} matches)`);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(50);
  });

  it('a whole typing session stays under budget (one full rescan per keystroke)', () => {
    const typed = 'level:error tag:dio "connection reset"';
    const t0 = performance.now();
    for (let k = 1; k <= typed.length; k++) {
      const c = compileLogQuery(parseLogQuery(typed.slice(0, k)), { now: NOW, apps: APPS });
      if (c.matchesAll) continue;
      for (let i = 0; i < entries.length; i++) c.test(entries[i]!);
    }
    const perKey = (performance.now() - t0) / typed.length;
    console.info(`[bench] typing ${JSON.stringify(typed)}: ${perKey.toFixed(1)} ms per keystroke (full rescan of ${N} entries)`);
    expect(perKey).toBeLessThan(50);
  });

  it('analysis helpers over the whole ring', () => {
    let t0 = performance.now();
    let json = 0;
    for (const e of entries) if (findJsonPayload(e.message)) json++;
    const tJson = performance.now() - t0;
    t0 = performance.now();
    let stacks = 0;
    for (const e of entries) if (looksLikeStackTrace(e)) stacks++;
    const tStack = performance.now() - t0;
    console.info(`[bench] findJsonPayload × ${N}: ${tJson.toFixed(1)} ms (${json}) · looksLikeStackTrace × ${N}: ${tStack.toFixed(1)} ms (${stacks})`);
    expect(json).toBeGreaterThan(0);
    expect(stacks).toBeGreaterThan(0);
    expect(tJson).toBeLessThan(150);
    expect(tStack).toBeLessThan(100);
  });
});
