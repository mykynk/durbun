import { describe, expect, it } from 'vitest';
import { encodeNdjson, NdjsonDecoder } from '../../src/sdk/ndjson';
import { parseSdkMessage } from '../../src/sdk/validate';

function decoder(max?: number) {
  const lines: string[] = [];
  const oversize: number[] = [];
  const d = new NdjsonDecoder({ onLine: (l) => lines.push(l), onOversize: (n) => oversize.push(n), maxLineBytes: max });
  return { d, lines, oversize };
}

describe('NdjsonDecoder', () => {
  it('splits lines across arbitrary chunk boundaries', () => {
    const { d, lines } = decoder();
    const payload = `${encodeNdjson({ type: 'log', message: 'a' })}${encodeNdjson({ type: 'log', message: 'b' })}`;
    for (const ch of payload) d.push(ch);
    expect(lines.map((l) => JSON.parse(l).message)).toEqual(['a', 'b']);
  });

  it('reassembles multi-byte UTF-8 characters split between chunks', () => {
    const { d, lines } = decoder();
    const text = 'Kullanıcı giriş yaptı — ödeme ✓ 🐾 çğşİÖÜ';
    const bytes = Buffer.from(encodeNdjson({ message: text }), 'utf8');
    // split every 1, 2 and 3 bytes so cuts land inside 2-, 3- and 4-byte sequences
    for (const step of [1, 2, 3]) {
      for (let i = 0; i < bytes.length; i += step) d.push(bytes.subarray(i, i + step));
    }
    expect(lines.map((l) => JSON.parse(l).message)).toEqual([text, text, text]);
  });

  it('handles CRLF, blank lines, a BOM and several lines per chunk', () => {
    const { d, lines } = decoder();
    d.push(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"n":1}\r\n\r\n   \n{"n":2}\n{"n":')]));
    d.push('3}\n');
    expect(lines).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
  });

  it('drops oversized lines (also when they span chunks) and resumes after them', () => {
    const { d, lines, oversize } = decoder(32);
    d.push('{"ok":1}\n');
    d.push('x'.repeat(20));
    d.push('y'.repeat(20)); // > 32 bytes without a newline → discarding
    d.push('z'.repeat(10));
    d.push('\n{"ok":2}\n');
    d.push(`${'q'.repeat(40)}\n{"ok":3}\n`);
    expect(lines).toEqual(['{"ok":1}', '{"ok":2}', '{"ok":3}']);
    expect(oversize).toEqual([50, 40]);
  });

  it('delivers an unterminated final line on end()', () => {
    const { d, lines } = decoder();
    d.push('{"last":true}');
    expect(lines).toEqual([]);
    d.end();
    expect(lines).toEqual(['{"last":true}']);
  });
});

describe('parseSdkMessage', () => {
  it('rejects garbage', () => {
    for (const v of [null, 42, 'hello', [], {}, { type: 7 }, { type: 'nope' }, { type: 'net.request', id: '1' }, { type: 'event' }, { type: 'metric', ts: 1 }]) {
      expect(parseSdkMessage(v)).toBeUndefined();
    }
  });

  it('requires an app id in hello and fills safe defaults', () => {
    expect(parseSdkMessage({ type: 'hello', app: { name: 'x' } })).toBeUndefined();
    const h = parseSdkMessage({
      type: 'hello',
      app: { id: 'com.x', pid: '12' },
      device: { platform: 'ios', simulatorUdid: 'a1b2c3d4-0000-4000-8000-000000000001' },
      capabilities: ['logs', 'bogus', 'logs'],
      actions: [{ id: 'flutter.debugPaint', kind: 'toggle', label: 'Debug paint' }, { id: 'bad', kind: 'weird' }],
    });
    expect(h).toMatchObject({
      type: 'hello',
      protocol: 1,
      app: { id: 'com.x', name: 'com.x' },
      sdk: { platform: 'ios', name: 'unknown' },
      device: { platform: 'ios', simulatorUdid: 'A1B2C3D4-0000-4000-8000-000000000001' },
      capabilities: ['logs'],
      actions: [{ id: 'flutter.debugPaint', kind: 'toggle', label: 'Debug paint' }],
    });
    expect((h as { session: string }).session.length).toBeGreaterThan(8);
    expect((h as { app: { pid?: number } }).app.pid).toBeUndefined();
  });

  it('normalizes logs, requests and bodies', () => {
    expect(parseSdkMessage({ type: 'log', level: 'LOUD', message: { a: 1 }, kind: 'weird', ts: 'x' })).toMatchObject({
      type: 'log',
      level: 'info',
      message: '{"a":1}',
    });
    const r = parseSdkMessage({
      type: 'net.request',
      id: 17,
      method: 'post',
      url: 'https://api.pati.app/v1/pets',
      headers: { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] },
      body: { encoding: 'base64', data: 'aGVsbG8=' },
    });
    expect(r).toMatchObject({
      id: '17',
      method: 'POST',
      source: 'sdk',
      headers: [
        ['content-type', 'application/json'],
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
      ],
      body: { encoding: 'base64', data: 'aGVsbG8=', size: 5 },
    });
  });
});
