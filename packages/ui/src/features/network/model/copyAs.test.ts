import { describe, expect, it } from 'vitest';
import { copyAs, dartString, kotlinString, shellQuote, swiftString, toCurl, toDio, toFetch, toKotlin, toSwift, type CopyRequest } from './copyAs';

const json = (data: string, extra: Partial<{ truncated: boolean; size: number }> = {}) => ({ encoding: 'utf8' as const, data, size: new TextEncoder().encode(data).length, ...extra });

const post: CopyRequest = {
  method: 'POST',
  url: 'https://api.pati.app/v1/pets?filter=a&b=c d',
  headers: [
    ['content-type', 'application/json; charset=utf-8'],
    ['authorization', 'Bearer abc.def'],
    ['x-time', '12:30:00'],
    ['accept-encoding', 'gzip, br'],
    ['content-length', '42'],
    [':authority', 'api.pati.app'],
  ],
  body: json('{"name":"Pamuk\'un evi","emoji":"🐾","note":"satır1\\nsatır2"}'),
};

describe('shellQuote', () => {
  it('quotes with POSIX single-quote escaping', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('PATCH')).toBe('PATCH');
    expect(shellQuote('')).toBe("''");
    expect(shellQuote('a b $HOME `x` !')).toBe("'a b $HOME `x` !'");
    expect(shellQuote('çok güzel\nyeni satır')).toBe("'çok güzel\nyeni satır'");
  });
});

describe('cURL', () => {
  it('builds a multi-line command with headers, body and --compressed', () => {
    const { code, notes } = toCurl(post);
    expect(notes).toEqual([]);
    const lines = code.split(' \\\n  ');
    expect(lines[0]).toBe("curl 'https://api.pati.app/v1/pets?filter=a&b=c d'");
    expect(code).not.toContain('-X POST'); // implied by --data-raw
    expect(code).toContain("-H 'x-time: 12:30:00'");
    expect(code).toContain("-H 'authorization: Bearer abc.def'");
    expect(code).not.toMatch(/content-length|:authority|accept-encoding/i);
    expect(code).toContain(`--data-raw '{"name":"Pamuk'\\''un evi","emoji":"🐾","note":"satır1\\nsatır2"}'`);
    expect(lines[lines.length - 1]).toBe('--compressed');
  });

  it('uses -X for methods curl cannot infer and --head for HEAD', () => {
    expect(toCurl({ method: 'DELETE', url: 'https://x.dev/a', headers: [] }).code).toBe("curl 'https://x.dev/a' \\\n  -X DELETE");
    expect(toCurl({ method: 'GET', url: 'https://x.dev/a', headers: [] }).code).toBe("curl 'https://x.dev/a'");
    expect(toCurl({ method: 'HEAD', url: 'https://x.dev/a', headers: [] }).code).toContain('--head');
    expect(toCurl({ method: 'PUT', url: 'https://x.dev/a', headers: [], body: json('x') }).code).toContain('-X PUT');
  });

  it('references a file for binary bodies and explains it in a note', () => {
    const r = toCurl({ method: 'POST', url: 'https://x.dev/up', headers: [['content-type', 'image/png']], body: { encoding: 'base64', data: 'iVBORw0KGgo=', size: 8 } });
    expect(r.code).toContain('--data-binary @body.bin');
    expect(r.notes).toEqual([{ code: 'binaryBody', size: 8 }]);
  });

  it('notes size-only (not captured) and truncated bodies', () => {
    const notCaptured = toCurl({ method: 'POST', url: 'https://x.dev', headers: [], body: { encoding: 'utf8', data: '', size: 5000, truncated: true } });
    expect(notCaptured.code).not.toContain('--data');
    expect(notCaptured.notes).toEqual([{ code: 'bodyNotCaptured' }]);
    const truncated = toCurl({ method: 'POST', url: 'https://x.dev', headers: [], body: json('{"a":', { truncated: true, size: 9000 }) });
    expect(truncated.notes[0]).toMatchObject({ code: 'bodyTruncated', size: 9000 });
    const missing = toCurl({ method: 'POST', url: 'https://x.dev', headers: [], hasBody: true });
    expect(missing.notes).toEqual([{ code: 'bodyNotCaptured' }]);
  });

  it('handles an empty body string as no body', () => {
    expect(toCurl({ method: 'POST', url: 'https://x.dev', headers: [], body: json('') }).code).toBe("curl 'https://x.dev' \\\n  -X POST");
  });
});

describe('fetch', () => {
  it('produces valid JS with JSON bodies re-serialized and headers merged', () => {
    const { code } = toFetch({ ...post, headers: [...post.headers, ['Cookie', 'a=1'], ['cookie', 'b=2']] });
    expect(code.startsWith('const response = await fetch("https://api.pati.app/v1/pets?filter=a&b=c d", {')).toBe(true);
    expect(code).toContain('"x-time": "12:30:00"');
    expect(code).toContain('"Cookie": "a=1; b=2"');
    expect(code).toContain('body: JSON.stringify({');
    // The generated code must parse and keep the body identical.
    const body = /body: JSON\.stringify\(([\s\S]*)\),\n\}\);$/.exec(code)![1]!;
    expect(JSON.parse(body)).toEqual(JSON.parse(post.body!.data));
  });

  it('keeps non-JSON text as a string literal and inlines small binaries', () => {
    expect(toFetch({ method: 'POST', url: 'https://x.dev', headers: [['content-type', 'text/plain']], body: json('a "quoted"\nline') }).code).toContain('body: "a \\"quoted\\"\\nline",');
    const bin = toFetch({ method: 'POST', url: 'https://x.dev', headers: [], body: { encoding: 'base64', data: 'AAEC', size: 3 } });
    expect(bin.code).toContain('Uint8Array.from(atob("AAEC")');
  });
});

describe('language string literals', () => {
  const nasty = 'tek \' çift " ters \\ dolar $x {y} \n\t\u0001 🐾';
  it('Dart escapes quotes, $, backslashes and control characters', () => {
    expect(dartString(nasty)).toBe("'tek \\' çift \" ters \\\\ dolar \\$x {y} \\n\\t\\u{1} 🐾'");
  });
  it('Swift escapes quotes, backslashes (so no interpolation) and control characters', () => {
    expect(swiftString(nasty)).toBe('"tek \' çift \\" ters \\\\ dolar $x {y} \\n\\t\\u{1} 🐾"');
    expect(swiftString('\\(evil)')).toBe('"\\\\(evil)"');
  });
  it('Kotlin escapes quotes, $ templates and control characters', () => {
    expect(kotlinString(nasty)).toBe('"tek \' çift \\" ters \\\\ dolar \\$x {y} \\n\\t\\u0001 🐾"');
  });
});

describe('Dart (dio)', () => {
  it('builds a dio request with method, headers and body', () => {
    const { code } = toDio(post);
    expect(code).toContain("import 'package:dio/dio.dart';");
    expect(code).toContain("'https://api.pati.app/v1/pets?filter=a&b=c d',");
    expect(code).toContain("method: 'POST',");
    expect(code).toContain("'x-time': '12:30:00',");
    expect(code).toContain("data: '{\"name\":\"Pamuk\\'un evi\",\"emoji\":\"🐾\",\"note\":\"satır1\\\\nsatır2\"}',");
    expect(code).not.toContain('content-length');
  });
  it('decodes base64 bodies with dart:convert', () => {
    const { code } = toDio({ method: 'PUT', url: 'https://x.dev', headers: [], body: { encoding: 'base64', data: 'AAEC', size: 3 } });
    expect(code).toContain("import 'dart:convert';");
    expect(code).toContain("data: base64Decode('AAEC'),");
  });
});

describe('Swift (URLSession)', () => {
  it('builds a URLRequest', () => {
    const { code } = toSwift(post);
    expect(code).toContain('var request = URLRequest(url: URL(string: "https://api.pati.app/v1/pets?filter=a&b=c d")!)');
    expect(code).toContain('request.httpMethod = "POST"');
    expect(code).toContain('request.addValue("12:30:00", forHTTPHeaderField: "x-time")');
    expect(code).toContain('request.httpBody = Data("{\\"name\\":\\"Pamuk\'un evi\\"');
    expect(code).toContain('try await URLSession.shared.data(for: request)');
  });
  it('uses Data(base64Encoded:) for binary bodies and omits huge ones', () => {
    expect(toSwift({ method: 'POST', url: 'https://x.dev', headers: [], body: { encoding: 'base64', data: 'AAEC', size: 3 } }).code).toContain('Data(base64Encoded: "AAEC")');
    const big = 'A'.repeat(400_000);
    const r = toSwift({ method: 'POST', url: 'https://x.dev', headers: [], body: { encoding: 'base64', data: big, size: 300_000 } });
    expect(r.code).not.toContain(big.slice(0, 1000));
    expect(r.notes.some((n) => n.code === 'bodyOmitted')).toBe(true);
  });
});

describe('Kotlin (OkHttp)', () => {
  it('builds an OkHttp request with media type and headers', () => {
    const { code } = toKotlin(post);
    expect(code).toContain('import okhttp3.MediaType.Companion.toMediaType');
    expect(code).toContain('.url("https://api.pati.app/v1/pets?filter=a&b=c d")');
    expect(code).toContain('.addHeader("x-time", "12:30:00")');
    expect(code).toContain('.toRequestBody("application/json; charset=utf-8".toMediaType())');
    expect(code).toContain('.method("POST", ');
  });
  it('uses .get() for GET and an empty body for body-less POST', () => {
    expect(toKotlin({ method: 'GET', url: 'https://x.dev', headers: [] }).code).toContain('.get()');
    expect(toKotlin({ method: 'POST', url: 'https://x.dev', headers: [] }).code).toContain('.method("POST", ByteArray(0).toRequestBody(null))');
    expect(toKotlin({ method: 'DELETE', url: 'https://x.dev', headers: [] }).code).toContain('.method("DELETE", null)');
  });
  it('escapes $ in URLs and bodies', () => {
    const { code } = toKotlin({ method: 'POST', url: 'https://x.dev/?q=$price', headers: [], body: json('{"p":"$9"}') });
    expect(code).toContain('.url("https://x.dev/?q=\\$price")');
    expect(code).toContain('"{\\"p\\":\\"\\$9\\"}".toRequestBody(null)');
  });
});

describe('copyAs dispatch', () => {
  it('routes every format and treats unknown methods as GET', () => {
    for (const f of ['curl', 'fetch', 'dio', 'swift', 'kotlin'] as const) {
      expect(copyAs(f, { method: '?', url: 'https://x.dev', headers: [] }).code.length).toBeGreaterThan(10);
    }
    expect(copyAs('fetch', { method: '?', url: 'https://x.dev', headers: [] }).code).toContain('method: "GET"');
  });
});
