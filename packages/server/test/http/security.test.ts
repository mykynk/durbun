import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { streamJson } from '../../src/http/jsonStream';
import { describeFetchError, prepareReplay } from '../../src/http/replay';
import { allowedOrigins, checkLocalAccess, isLoopbackAddress, isLoopbackHostHeader } from '../../src/http/security';
import { contentDisposition, fileTimestamp } from '../../src/http/util';
import { sampleNetwork } from './fakes';

function req(remoteAddress: string | undefined, headers: Record<string, string> = {}): Pick<IncomingMessage, 'headers' | 'socket'> {
  return { headers, socket: { remoteAddress } } as unknown as Pick<IncomingMessage, 'headers' | 'socket'>;
}

describe('security', () => {
  it('recognizes loopback peers (IPv4, IPv6, IPv4-mapped)', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(a), a).toBe(true);
    for (const a of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20', 'fe80::1', '', undefined, '0.0.0.0']) expect(isLoopbackAddress(a), String(a)).toBe(false);
  });

  it('rejects LAN peers even with a perfect Origin', () => {
    const r = checkLocalAccess(req('192.168.1.42', { origin: 'http://localhost:9750', host: 'localhost:9750' }), 9750);
    expect(r).toEqual({ ok: false, reason: 'client 192.168.1.42 is not on this computer' });
    expect(checkLocalAccess(req('::ffff:10.0.0.7'), 9750).ok).toBe(false);
  });

  it('allows the UI origin, the Vite dev server and Origin-less local tools', () => {
    expect([...allowedOrigins(9750)].sort()).toEqual(
      ['http://127.0.0.1:5173', 'http://127.0.0.1:9750', 'http://[::1]:5173', 'http://[::1]:9750', 'http://localhost:5173', 'http://localhost:9750'].sort(),
    );
    expect(checkLocalAccess(req('127.0.0.1', { origin: 'http://localhost:9750', host: 'localhost:9750', 'sec-fetch-site': 'same-origin' }), 9750)).toEqual({ ok: true });
    expect(checkLocalAccess(req('127.0.0.1', { origin: 'http://localhost:5173/', host: 'localhost:5173' }), 9750)).toEqual({ ok: true });
    expect(checkLocalAccess(req('::1', { host: '[::1]:9750' }), 9750)).toEqual({ ok: true });
    expect(checkLocalAccess(req('127.0.0.1', { 'sec-fetch-site': 'none' }), 9750)).toEqual({ ok: true });
    // Custom port: allow-list follows it.
    expect(checkLocalAccess(req('127.0.0.1', { origin: 'http://localhost:9800' }), 9800)).toEqual({ ok: true });
    expect(checkLocalAccess(req('127.0.0.1', { origin: 'http://localhost:9750' }), 9800).ok).toBe(false);
  });

  it('blocks other origins, cross-site fetch metadata and DNS-rebinding hosts', () => {
    const cases: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { origin: 'http://localhost.evil.example:9750' },
      { origin: 'null' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { host: 'evil.example:9750' },
      { host: '127.0.0.1.nip.io:9750' },
    ];
    for (const headers of cases) expect(checkLocalAccess(req('127.0.0.1', headers), 9750).ok, JSON.stringify(headers)).toBe(false);
    expect(isLoopbackHostHeader('durbun.localhost:9750')).toBe(true);
    expect(isLoopbackHostHeader(undefined)).toBe(true);
  });
});

describe('replay preparation', () => {
  it('drops hop-by-hop headers and keeps the captured body', () => {
    const p = prepareReplay(
      sampleNetwork('a', {
        method: 'post',
        requestHeaders: [
          ['Host', 'api.pati.app'],
          ['Content-Length', '12'],
          ['Connection', 'keep-alive'],
          [':authority', 'api.pati.app'],
          ['Content-Type', 'application/json'],
          ['X-Bad', 'line\r\nbreak'],
          ['Authorization', 'Bearer x'],
        ],
        requestBody: { encoding: 'utf8', data: '{"a":1}', size: 7 },
        hasRequestBody: true,
      }),
    );
    expect(p.method).toBe('POST');
    expect(p.headers).toEqual([
      ['Content-Type', 'application/json'],
      ['Authorization', 'Bearer x'],
    ]);
    expect(p.body?.toString()).toBe('{"a":1}');
    expect(p.warnings).toEqual([]);
  });

  it('applies overrides and validates them', () => {
    const base = sampleNetwork('a', { method: 'POST', requestBody: { encoding: 'base64', data: Buffer.from('hi').toString('base64'), size: 2 }, hasRequestBody: true });
    const p = prepareReplay(base, { url: 'http://localhost:8080/x', body: 'eyJ4IjoxfQ==', bodyEncoding: 'base64', headers: [['X-One', '1']] });
    expect(p.url).toBe('http://localhost:8080/x');
    expect(p.body?.toString()).toBe('{"x":1}');
    expect(p.headers).toEqual([['X-One', '1']]);
    expect(() => prepareReplay(base, { url: 'ftp://files.pati.app/x' })).toThrow(/Only http and https/);
    expect(() => prepareReplay(base, { url: 'not a url' })).toThrow(/Invalid URL/);
    expect(() => prepareReplay(base, { method: 'GE T' })).toThrow(/Invalid HTTP method/);
    expect(() => prepareReplay({ ...base, method: '?' })).toThrow(/never seen/);
  });

  it('warns about truncated or missing bodies', () => {
    const truncated = prepareReplay(sampleNetwork('a', { method: 'PUT', requestBody: { encoding: 'utf8', data: 'abc', size: 9_000, truncated: true }, hasRequestBody: true }));
    expect(truncated.warnings.map((w) => w.code)).toEqual(['replay.bodyTruncated']);
    const evicted = prepareReplay(sampleNetwork('a', { method: 'PUT', hasRequestBody: true, bodyEvicted: true }));
    expect(evicted.warnings[0]).toMatchObject({ code: 'replay.bodyMissing', message: expect.stringContaining('evicted') });
    expect(evicted.body).toBeUndefined();
  });

  it('describes fetch failures in plain words', () => {
    expect(describeFetchError(Object.assign(new Error('x'), { name: 'TimeoutError' }), 30_000)).toBe('Timed out after 30 s');
    expect(describeFetchError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.pati.invalid' } }), 30_000)).toBe(
      'DNS lookup failed: getaddrinfo ENOTFOUND api.pati.invalid',
    );
    expect(describeFetchError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' } }), 1)).toBe(
      'CERT_HAS_EXPIRED: certificate has expired',
    );
  });
});

describe('streamJson', () => {
  async function collect(value: unknown, depth: number): Promise<string> {
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (c: Buffer) => chunks.push(c));
    await streamJson(out, value, depth);
    out.end();
    return Buffer.concat(chunks).toString('utf8');
  }

  it('is byte-identical to JSON.stringify for plain data', async () => {
    const value = {
      format: 'durbun-session',
      skip: undefined,
      fn: () => 1,
      logs: Array.from({ length: 3_000 }, (_, i) => ({ id: i, message: `satır ${i} — "quoted"  `, data: i % 2 ? { nested: [1, undefined, 'x'] } : undefined })),
      empty: [],
      sparse: [1, undefined, () => 2, null],
      nested: { a: { b: [{ c: 1 }] } },
      date: new Date(0),
    };
    for (const depth of [0, 1, 2, 3]) expect(await collect(value, depth)).toBe(JSON.stringify(value));
  });
});

describe('util', () => {
  it('builds safe Content-Disposition headers', () => {
    expect(contentDisposition('durbun-2026-11-02.har')).toBe(`attachment; filename="durbun-2026-11-02.har"; filename*=UTF-8''durbun-2026-11-02.har`);
    expect(contentDisposition('ekran görüntüsü "1".png')).toBe(
      `attachment; filename="ekran g_r_nt_s_ _1_.png"; filename*=UTF-8''ekran%20g%C3%B6r%C3%BCnt%C3%BCs%C3%BC%20%221%22.png`,
    );
    expect(contentDisposition('a/b\\c\r\n.txt')).toContain('filename="a_b_c__.txt"');
  });

  it('formats file time stamps in local time', () => {
    expect(fileTimestamp(new Date(2026, 10, 2, 9, 5, 7))).toBe('2026-11-02-090507');
  });
});
