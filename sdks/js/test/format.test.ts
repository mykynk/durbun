import { describe, expect, it } from 'vitest';
import { extractTagPrefix, formatArgs } from '../src/format.js';
import { errorInfo, previewValue, toJsonSafe } from '../src/jsonSafe.js';
import { findHeader, headersFromInit, parseRawHeaders, toRawHeaders } from '../src/headers.js';

describe('formatArgs (console-style)', () => {
  it('joins primitives with spaces', () => {
    expect(formatArgs(['Sepet güncellendi', 3, true, null, undefined, 10n]).message).toBe('Sepet güncellendi 3 true null undefined 10n');
  });

  it('renders objects as compact JSON and keeps them as structured data', () => {
    const user = { id: 42, name: 'Ayşe', roles: ['admin'] };
    const f = formatArgs(['User', user]);
    expect(f.message).toBe('User {"id":42,"name":"Ayşe","roles":["admin"]}');
    expect(f.data).toEqual(user);
    const two = formatArgs([{ a: 1 }, [1, 2]]);
    expect(two.data).toEqual([{ a: 1 }, [1, 2]]);
  });

  it('supports printf-style substitutions', () => {
    expect(formatArgs(['%s logged in with id %d (%i%%)', 'yusuf', 42.7, '99.9']).message).toBe('yusuf logged in with id 42.7 (99%)');
    expect(formatArgs(['pi=%f obj=%o', '3.14', { x: 1 }]).message).toBe('pi=3.14 obj={"x":1}');
    expect(formatArgs(['%cStyled%c text', 'color:red', '', 'extra']).message).toBe('Styled text extra');
    expect(formatArgs(['100%', 'done']).message).toBe('100% done');
    expect(formatArgs(['missing %s %s', 'one']).message).toBe('missing one %s');
    expect(formatArgs(['only %d']).message).toBe('only %d');
  });

  it('turns the first Error into error info (stack kept for folding)', () => {
    const err = new TypeError('Cannot read properties of undefined');
    const f = formatArgs(['Ödeme başarısız', err]);
    expect(f.message).toBe('Ödeme başarısız TypeError: Cannot read properties of undefined');
    expect(f.error?.type).toBe('TypeError');
    expect(f.error?.message).toBe('Cannot read properties of undefined');
    expect(f.error?.stack).toContain('TypeError');
    expect(f.data).toBeUndefined();
  });

  it('extracts a leading [Tag] as the log tag', () => {
    expect(formatArgs(['[Auth] Login ok', { userId: 1 }], { extractTag: true })).toMatchObject({ tag: 'Auth', message: 'Login ok {"userId":1}' });
    expect(extractTagPrefix('[api/v2] GET /users')).toEqual({ tag: 'api/v2', rest: 'GET /users' });
    expect(extractTagPrefix('[INFO] not a tag')).toBeUndefined();
    expect(extractTagPrefix('[12:30:01] time')).toBeUndefined();
    expect(extractTagPrefix('[Auth]no space')).toBeUndefined();
    expect(extractTagPrefix('[with space] x')).toBeUndefined();
    expect(formatArgs(['[Auth] x']).tag).toBeUndefined();
  });

  it('caps very large objects in the message but keeps them in data', () => {
    const big = { items: Array.from({ length: 500 }, (_, i) => ({ id: i, title: `Ürün ${i}` })) };
    const f = formatArgs(['Ürünler', big]);
    expect(f.message.length).toBeLessThan(1100);
    expect(f.message.endsWith('…')).toBe(true);
    expect((f.data as typeof big).items).toHaveLength(500);
  });
});

describe('toJsonSafe', () => {
  it('handles cycles, BigInt, special numbers, functions, symbols', () => {
    const a: Record<string, unknown> = { n: 1, big: 12345678901234567890n, nan: NaN, inf: -Infinity, fn: function named() {}, sym: Symbol('s'), undef: undefined };
    a.self = a;
    expect(toJsonSafe(a)).toEqual({ n: 1, big: '12345678901234567890n', nan: 'NaN', inf: '-Infinity', fn: '[Function: named]', sym: 'Symbol(s)', self: '[Circular]' });
  });

  it('keeps shared (non-cyclic) references', () => {
    const shared = { x: 1 };
    expect(toJsonSafe({ a: shared, b: shared })).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  it('converts Error, Date, RegExp, Map, Set, typed arrays, URL and toJSON', () => {
    const err = Object.assign(new Error('boom'), { code: 'E_BOOM' });
    const out = toJsonSafe({
      err,
      date: new Date('2026-11-02T10:00:00.000Z'),
      bad: new Date('nope'),
      re: /a+b/gi,
      map: new Map<unknown, unknown>([['k', 1], [2, 'two']]),
      objMap: new Map<unknown, unknown>([[{ id: 1 }, 'x']]),
      set: new Set([1, 'a']),
      bytes: new Uint8Array(16),
      buf: new ArrayBuffer(8),
      url: new URL('https://example.com/a?b=1'),
      custom: { toJSON: () => ({ serialized: true }) },
    }) as Record<string, any>;
    expect(out.err).toMatchObject({ name: 'Error', message: 'boom', code: 'E_BOOM' });
    expect(out.err.stack).toContain('boom');
    expect(out.date).toBe('2026-11-02T10:00:00.000Z');
    expect(out.bad).toBe('Invalid Date');
    expect(out.re).toBe('/a+b/gi');
    expect(out.map).toEqual({ k: 1, 2: 'two' });
    expect(out.objMap).toEqual([[{ id: 1 }, 'x']]);
    expect(out.set).toEqual([1, 'a']);
    expect(out.bytes).toBe('[Uint8Array(16)]');
    expect(out.buf).toBe('[ArrayBuffer(8)]');
    expect(out.url).toBe('https://example.com/a?b=1');
    expect(out.custom).toEqual({ serialized: true });
  });

  it('summarizes React elements and survives throwing getters / proxies', () => {
    const element = { $$typeof: Symbol.for('react.transitional.element'), type: function Button() {}, props: { children: 'x' } };
    const evil = Object.defineProperty({ ok: 1 }, 'bad', {
      enumerable: true,
      get() {
        throw new Error('nope');
      },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const out = toJsonSafe({ element, evil, proxy: revocable.proxy }) as Record<string, any>;
    expect(out.element).toBe('[React transitional.element: Button]');
    expect(out.evil).toEqual({ ok: 1, bad: '[Getter threw: nope]' });
    expect(out.proxy).toBe('[Unserializable]');
  });

  it('bounds depth, array length, key count and total work', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    let node = toJsonSafe(deep, { maxDepth: 3 }) as Record<string, any>;
    expect(node.child.child.child).toBe('[Object]');
    const arr = toJsonSafe(Array.from({ length: 5000 }, (_, i) => i), { maxArrayItems: 10 }) as unknown[];
    expect(arr).toHaveLength(11);
    expect(arr[10]).toBe('… 4990 more items');
    const wide = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    node = toJsonSafe(wide, { maxKeys: 5 }) as Record<string, any>;
    expect(Object.keys(node)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', '…']);
    const huge = Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => ({ v: 1 })));
    expect(JSON.stringify(toJsonSafe(huge, { maxNodes: 1000 }))).toContain('[…]');
    expect(toJsonSafe('x'.repeat(50), { maxStringLength: 10 })).toBe('xxxxxxxxxx… (50 chars)');
  });

  it('errorInfo appends cause chains and handles non-errors', () => {
    const root = new Error('ECONNREFUSED');
    const err = new Error('fetch failed', { cause: root });
    const info = errorInfo(err);
    expect(info.type).toBe('Error');
    expect(info.stack).toContain('Caused by: Error: ECONNREFUSED');
    const self = new Error('loop') as Error & { cause?: unknown };
    self.cause = self;
    expect(errorInfo(self).message).toBe('loop');
    expect(errorInfo('plain string')).toEqual({ type: 'string', message: 'plain string' });
    expect(errorInfo({ code: 1 })).toEqual({ type: 'Object', message: '{"code":1}' });
  });

  it('previewValue renders compact one-liners', () => {
    expect(previewValue({ a: [1, 2], b: 'ş' })).toBe('{"a":[1,2],"b":"ş"}');
    expect(previewValue('x'.repeat(20), 5)).toBe('xxxxx…');
    expect(previewValue(undefined)).toBe('undefined');
  });
});

describe('headers', () => {
  it('parses getAllResponseHeaders output', () => {
    const raw = 'content-type: application/json; charset=utf-8\r\nset-cookie: a=1\r\nset-cookie: b=2\r\nx-empty:\r\n\r\n';
    const parsed = parseRawHeaders(raw);
    expect(parsed).toEqual([
      ['content-type', 'application/json; charset=utf-8'],
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
      ['x-empty', ''],
    ]);
    expect(findHeader(parsed, 'Set-Cookie')).toBe('a=1, b=2');
    expect(findHeader(parsed, 'missing')).toBeUndefined();
    expect(parseRawHeaders(null)).toEqual([]);
    expect(toRawHeaders([['Content-Type', 'text/plain']])).toBe('content-type: text/plain\r\n');
  });

  it('normalizes every HeadersInit shape', () => {
    expect(headersFromInit({ Accept: 'application/json', 'X-Multi': ['1', '2'], skip: undefined })).toEqual([
      ['Accept', 'application/json'],
      ['X-Multi', '1'],
      ['X-Multi', '2'],
    ]);
    expect(headersFromInit([['Authorization', 'Bearer t']])).toEqual([['Authorization', 'Bearer t']]);
    const h = new Headers();
    h.append('Content-Type', 'application/json');
    h.append('X-Trace', 'abc');
    expect(headersFromInit(h)).toEqual([
      ['content-type', 'application/json'],
      ['x-trace', 'abc'],
    ]);
    expect(headersFromInit(undefined)).toEqual([]);
  });
});
