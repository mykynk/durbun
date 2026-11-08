import { describe, expect, it } from 'vitest';
import { parseJsonBuffer } from '../../src/http/jsonParse';

/** Imports are parsed member by member from the bytes (no 500 MB string); the result must equal JSON.parse. */

const same = async (text: string) => expect(await parseJsonBuffer(Buffer.from(text))).toEqual(JSON.parse(text));

describe('parseJsonBuffer', () => {
  it('equals JSON.parse for session-shaped and odd but valid JSON', async () => {
    await same(JSON.stringify({ format: 'durbun-session', version: 1, logs: [{ id: 1, message: 'Ödeme başarılı ✓ 🐾' }, { id: 2, message: 'a "quoted" \\ back\\\\slash \\"' }], network: [], metrics: [[1, 2], [], {}] }, null, 2));
    await same('{}');
    await same(' { "a" : [ ] , "b" : [ 1 , "x" , null , true , false , -1.5e3 , {"c":[{"d":"]}"}]} ] , "e" : "}" , "f" : { "g" : [ "[" ] } } ');
    await same('[1,2,{"a":"b"}]');
    await same('"just a string"');
    await same('42');
    await same('{"k":"\\u00e7\\"\\\\","n":{"\\"key\\"":1}}');
    await same('{"dup":1,"dup":2}');
  });

  it('keeps "__proto__" an own property like JSON.parse', async () => {
    const parsed = (await parseJsonBuffer(Buffer.from('{"__proto__":{"polluted":true},"logs":[]}'))) as Record<string, unknown>;
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.keys(parsed)).toEqual(['__proto__', 'logs']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('skips a BOM, treats a blank body as no value', async () => {
    expect(await parseJsonBuffer(Buffer.from('﻿{"a":1}'))).toEqual({ a: 1 });
    expect(await parseJsonBuffer(Buffer.from('  \n'))).toBeUndefined();
  });

  it('rejects invalid JSON with body.invalidJson', async () => {
    for (const text of ['{"format":', '{"a":[1,2,]}', '{"a":1}x', '{"a":"open}', '{a:1}', '{"a" 1}', '[1,2', '{"a":[1 2]}', '{"a":tru}']) {
      await expect(parseJsonBuffer(Buffer.from(text)), text).rejects.toMatchObject({ status: 400, code: 'body.invalidJson' });
    }
  });

  it('lets the event loop run while it parses a large list', async () => {
    const logs = Array.from({ length: 20_000 }, (_, i) => ({ id: i, message: `line ${i} ${'x'.repeat(100)}` }));
    const text = JSON.stringify({ format: 'durbun-session', logs });
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 0);
    try {
      expect(await parseJsonBuffer(Buffer.from(text), 64 * 1024)).toEqual(JSON.parse(text));
    } finally {
      clearInterval(ticker);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});
