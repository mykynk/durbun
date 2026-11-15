/** Masking of shared files (protocol secrets.ts) and local path cutting (exportClean.ts). */
import { describe, expect, it } from 'vitest';
import { isSecretHeader, isSecretName, maskBodyText, maskHeaderValue, maskLogEntry, maskUrl, SECRET_MASK, type LogEntry } from '@durbun/protocol';
import { MASK } from '../../src/flows/util';
import { maskParam, stripLocalPaths } from '../../src/http/exportClean';

describe('secret masking', () => {
  it('uses the flows marker and the flow builder heuristic', () => {
    expect(SECRET_MASK).toBe(MASK);
    for (const n of ['Authorization', 'Cookie', 'Set-Cookie', 'X-Api-Key', 'password', 'newPassword', 'api_key', 'accessKey', 'refresh_token', 'sessionId', 'pin']) expect(isSecretName(n), n).toBe(true);
    for (const n of ['Content-Type', 'idempotency-key', 'email', 'id', 'X-Request-Id', 'lang']) expect(isSecretName(n), n).toBe(false);
    expect(isSecretHeader('Access-Control-Allow-Credentials')).toBe(false);
    expect(isSecretHeader('X-Auth-Token')).toBe(true);
  });

  it('masks header values but keeps cookie names and the auth scheme', () => {
    expect(maskHeaderValue('Authorization', 'Bearer abc.def')).toBe('Bearer ••••');
    expect(maskHeaderValue('Authorization', 'abc')).toBe('••••');
    expect(maskHeaderValue('cookie', 'a=1; b=2')).toBe('a=••••; b=••••');
    expect(maskHeaderValue('Set-Cookie', 'sid=x; Path=/; Secure')).toBe('sid=••••; Path=/; Secure');
    expect(maskHeaderValue('X-Api-Key', 'k')).toBe('••••');
  });

  it('masks URL passwords and secret query values, leaves the rest', () => {
    expect(maskUrl('https://u:pw@api.example.com/a?token=x&page=2#top')).toBe('https://u:••••@api.example.com/a?token=••••&page=2#top');
    expect(maskUrl('/v1/items?api_key=k&q=kedi')).toBe('/v1/items?api_key=••••&q=kedi');
    expect(maskUrl('https://api.example.com/plain')).toBe('https://api.example.com/plain');
  });

  it('masks JSON (also truncated) and form bodies', () => {
    expect(maskBodyText('{"user":"a","password":"p\\"w","otp":123456,"nested":{"refreshToken":"r"}}', 'application/json')).toBe(
      '{"user":"a","password":"••••","otp":"••••","nested":{"refreshToken":"••••"}}',
    );
    expect(maskBodyText('{"token":"abc","items":[1,2', undefined)).toBe('{"token":"••••","items":[1,2');
    expect(maskBodyText('username=ali&password=p%40ss', 'application/x-www-form-urlencoded; charset=utf-8')).toBe('username=ali&password=••••');
    expect(maskBodyText('token is abc', 'text/plain')).toBe('token is abc');
  });

  it('masks the URL of network log rows only', () => {
    const row = { id: 1, ts: 1, deviceId: 'd', source: 'app', level: 'info', tag: 'network', kind: 'network', message: 'GET https://x.test/a?sig=abc' } as LogEntry;
    expect(maskLogEntry(row).message).toBe('GET https://x.test/a?sig=••••');
    const text = { ...row, kind: 'text', message: 'https://x.test/a?sig=abc' } as LogEntry;
    expect(maskLogEntry(text)).toBe(text);
  });
});

describe('export options', () => {
  it('masks unless mask is 0/false/no/off', () => {
    expect(maskParam(null)).toBe(true);
    expect(maskParam('1')).toBe(true);
    expect(maskParam('')).toBe(true);
    expect(maskParam('yes')).toBe(true);
    for (const v of ['0', 'false', 'FALSE', 'no', 'off']) expect(maskParam(v), v).toBe(false);
  });

  it('cuts local paths to file names', () => {
    const row = {
      id: 1,
      ts: 1,
      deviceId: 'd',
      source: 'device',
      level: 'fatal',
      tag: 'crash',
      kind: 'crash',
      message: 'boom',
      data: { file: '/opt/elsewhere/Runner.ips', list: ['/Users/ayse/Library/Logs/x.ips', 'relative/y.txt'], url: '/api/files/crash/a/b.ips' },
    } as LogEntry;
    const out = stripLocalPaths(row, ['/Users/ayse']);
    expect(out.data).toEqual({ file: 'Runner.ips', list: ['x.ips', 'relative/y.txt'], url: '/api/files/crash/a/b.ips' });
    const plain = { ...row, data: { bundleId: 'com.x' } } as LogEntry;
    expect(stripLocalPaths(plain, ['/Users/ayse'])).toBe(plain);
  });
});
