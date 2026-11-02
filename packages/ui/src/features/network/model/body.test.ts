import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  boundaryOf,
  bytesToBase64,
  classifyBody,
  decodeBody,
  decodeUtf8Text,
  formatGraphql,
  graphqlErrors,
  hexDump,
  parseGraphqlRequest,
  parseMultipart,
  prettyJsonText,
  sniffImage,
} from './body';
import { displayUrl, parseCookieHeader, parseParams, parseSetCookie, queryParams, reasonPhrase, responseCookies, safeFileStem, splitFoldedSetCookie, splitPathQuery } from './http';

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('bytes', () => {
  it('round-trips base64 (url-safe and unpadded input too)', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const b64 = bytesToBase64(bytes);
    expect(base64ToBytes(b64)).toEqual(bytes);
    expect(base64ToBytes(b64.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'))).toEqual(bytes);
    expect(base64ToBytes('%%%')).toEqual(new Uint8Array(0));
  });
  it('decodes UTF-8 text, tolerates a character cut at the end, rejects binary', () => {
    const tr = new TextEncoder().encode('Kedi ve köpek dostu 🐾');
    expect(decodeUtf8Text(tr)).toBe('Kedi ve köpek dostu 🐾');
    expect(decodeUtf8Text(tr.subarray(0, tr.length - 2))).toBe('Kedi ve köpek dostu ');
    expect(decodeUtf8Text(base64ToBytes(PNG_1x1))).toBeNull();
    expect(decodeUtf8Text(new Uint8Array([104, 105, 0, 1, 2]))).toBeNull();
  });
});

describe('DecodedBody + classifyBody', () => {
  it('detects size-only placeholders, truncation and empty bodies', () => {
    const placeholder = decodeBody({ encoding: 'utf8', data: '', size: 12_700, truncated: true })!;
    expect(placeholder.notCaptured).toBe(true);
    expect(placeholder.truncated).toBe(false);
    expect(classifyBody('application/json', placeholder)).toBe('notCaptured');
    const truncated = decodeBody({ encoding: 'utf8', data: '{"a":[1,2', size: 3_355_443, truncated: true })!;
    expect(truncated.truncated).toBe(true);
    expect(truncated.capturedBytes).toBe(9);
    expect(truncated.size).toBe(3_355_443);
    expect(classifyBody('application/json', decodeBody({ encoding: 'utf8', data: '', size: 0 })!)).toBe('empty');
  });
  it('classifies by content type and by content', () => {
    const text = (data: string) => decodeBody({ encoding: 'utf8', data, size: data.length })!;
    expect(classifyBody('application/json; charset=utf-8', text('{"a":1}'))).toBe('json');
    expect(classifyBody(undefined, text('[1,2]'))).toBe('json');
    expect(classifyBody('text/html', text('<p>x</p>'))).toBe('html');
    expect(classifyBody(undefined, text('<!DOCTYPE html><html></html>'))).toBe('html');
    expect(classifyBody('application/xml', text('<a/>'))).toBe('xml');
    expect(classifyBody('image/svg+xml', text('<svg/>'))).toBe('svg');
    expect(classifyBody('application/x-www-form-urlencoded', text('a=1'))).toBe('form');
    expect(classifyBody('text/plain', text('merhaba'))).toBe('text');
    const png = decodeBody({ encoding: 'base64', data: PNG_1x1, size: 70 })!;
    expect(classifyBody('image/png', png)).toBe('image');
    expect(classifyBody('application/octet-stream', png)).toBe('image');
    expect(classifyBody('application/octet-stream', decodeBody({ encoding: 'base64', data: 'AAECAwQF', size: 6 })!)).toBe('binary');
  });
  it('pretty prints JSON with optional sorted keys', () => {
    expect(prettyJsonText('{"b":1,"a":{"d":1,"c":2}}', { sortKeys: true })).toBe('{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}');
    expect(prettyJsonText('{nope')).toBeNull();
  });
});

describe('images and hex', () => {
  it('reads PNG / GIF / JPEG dimensions from headers', () => {
    expect(sniffImage(base64ToBytes(PNG_1x1))).toEqual({ format: 'png', width: 1, height: 1 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00]);
    expect(sniffImage(gif)).toEqual({ format: 'gif', width: 320, height: 240 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]);
    expect(sniffImage(jpeg)).toEqual({ format: 'jpeg', width: 800, height: 600 });
    expect(sniffImage(new Uint8Array([1, 2, 3]))).toBeNull();
  });
  it('dumps bytes with offsets and an ASCII column', () => {
    const bytes = new TextEncoder().encode('Hello, Dürbün!\n\u0000');
    const dump = hexDump(bytes);
    const lines = dump.split('\n');
    expect(lines[0]).toBe('00000000  48 65 6c 6c 6f 2c 20 44  c3 bc 72 62 c3 bc 6e 21  |Hello, D..rb..n!|');
    expect(lines[1]!.startsWith('00000010  0a 00 ')).toBe(true);
    expect(lines[1]!.endsWith('|..|')).toBe(true);
    // every line has the same width: 16 × 3 hex columns + the gap between the two groups
    expect(hexDump(bytes, 16, 17)).toBe(`00000010  0a ${' '.repeat(3 * 15 + 2)}|.|`);
    expect(hexDump(bytes, 16, 17).length).toBe(lines[0]!.length - 15); // 15 fewer ASCII characters
  });
});

describe('multipart', () => {
  const boundary = 'dart-http-boundary-abc';
  const head = `--${boundary}\r\ncontent-disposition: form-data; name="petId"\r\n\r\npet-42\r\n--${boundary}\r\ncontent-type: image/png\r\ncontent-disposition: form-data; name="file"; filename="IMG_2041.png"\r\n\r\n`;
  it('reads the boundary from the content type', () => {
    expect(boundaryOf(`multipart/form-data; boundary=${boundary}`)).toBe(boundary);
    expect(boundaryOf('multipart/form-data; boundary="a b"; charset=utf-8')).toBe('a b');
    expect(boundaryOf('application/json')).toBeUndefined();
  });
  it('parses complete bodies', () => {
    const enc = new TextEncoder();
    const png = base64ToBytes(PNG_1x1);
    const tail = enc.encode(`\r\n--${boundary}--\r\n`);
    const all = new Uint8Array([...enc.encode(head), ...png, ...tail]);
    const { parts, complete } = parseMultipart(all, boundary);
    expect(complete).toBe(true);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ name: 'petId', text: 'pet-42', size: 6, truncated: false });
    expect(parts[1]).toMatchObject({ name: 'file', filename: 'IMG_2041.png', contentType: 'image/png', size: png.length, truncated: false });
  });
  it('marks the last part of a truncated capture', () => {
    const enc = new TextEncoder();
    const cut = new Uint8Array([...enc.encode(head), 1, 2, 3]);
    const { parts, complete } = parseMultipart(cut, boundary);
    expect(complete).toBe(false);
    expect(parts[1]).toMatchObject({ filename: 'IMG_2041.png', size: 3, truncated: true });
  });
});

describe('GraphQL', () => {
  it('extracts operations from JSON bodies, batches and GET URLs', () => {
    const body = JSON.stringify({ query: 'query GetPet($id: ID!) { pet(id: $id) { id name } }', variables: { id: 'p1' }, operationName: 'GetPet' });
    expect(parseGraphqlRequest({ method: 'POST', url: 'https://gql.pati.app/graphql', contentType: 'application/json', text: body })).toEqual([
      { query: 'query GetPet($id: ID!) { pet(id: $id) { id name } }', variables: { id: 'p1' }, operationName: 'GetPet' },
    ]);
    expect(parseGraphqlRequest({ method: 'POST', url: 'x', text: `[${body},${body}]` })).toHaveLength(2);
    const get = parseGraphqlRequest({ method: 'GET', url: 'https://x.dev/graphql?query=%7Bme%7Bid%7D%7D&variables=%7B%22a%22%3A1%7D' });
    expect(get).toEqual([{ query: '{me{id}}', variables: { a: 1 } }]);
    expect(parseGraphqlRequest({ method: 'POST', url: 'x', contentType: 'application/json', text: '{"a":1}' })).toBeNull();
  });
  it('collects response errors with path, location and code', () => {
    const res = { data: null, errors: [{ message: 'Pet not found', path: ['pet', 0, 'owner'], locations: [{ line: 2, column: 3 }], extensions: { code: 'NOT_FOUND' } }] };
    expect(graphqlErrors(res)).toEqual([{ message: 'Pet not found', path: 'pet[0].owner', locations: '2:3', code: 'NOT_FOUND' }]);
    expect(graphqlErrors({ data: {} })).toEqual([]);
  });
  it('formats minified documents', () => {
    expect(formatGraphql('query GetUser($id: ID!, $first: Int = 10) { user(id: $id) { id name friends(first: $first, filter: {active: true, tags: ["a", "b"]}) { ...F ... on Admin { level } } } }')).toBe(
      [
        'query GetUser($id: ID!, $first: Int = 10) {',
        '  user(id: $id) {',
        '    id',
        '    name',
        '    friends(first: $first, filter: { active: true, tags: ["a", "b"] }) {',
        '      ...F',
        '      ... on Admin {',
        '        level',
        '      }',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(formatGraphql('mutation { like(id: 1) @client small: avatar(size: 64) }')).toBe('mutation {\n  like(id: 1) @client\n  small: avatar(size: 64)\n}');
    expect(formatGraphql('{a} {b}')).toBe('{\n  a\n}\n\n{\n  b\n}');
  });
});

describe('http helpers', () => {
  it('parses query parameters (decoded, duplicates kept, broken escapes tolerated)', () => {
    expect(queryParams('https://x.dev/a?q=k%C3%B6pek+mama&tag=a&tag=b&flag&bad=%E0%A4%A#frag')).toEqual([
      { name: 'q', value: 'köpek mama' },
      { name: 'tag', value: 'a' },
      { name: 'tag', value: 'b' },
      { name: 'flag', value: '' },
      { name: 'bad', value: '%E0%A4%A' },
    ]);
    expect(parseParams('')).toEqual([]);
    expect(splitPathQuery('/v1/pets?page=2')).toEqual({ pathname: '/v1/pets', query: '?page=2' });
  });
  it('parses Cookie and Set-Cookie headers, including folded ones', () => {
    expect(parseCookieHeader('session=abc; theme=dark; flag')).toEqual([
      { name: 'session', value: 'abc' },
      { name: 'theme', value: 'dark' },
      { name: 'flag', value: '' },
    ]);
    expect(parseSetCookie('sid=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly; Secure; SameSite=Lax; Priority=High')).toEqual({
      name: 'sid',
      value: '1',
      path: '/',
      expires: 'Wed, 21 Oct 2026 07:28:00 GMT',
      sameSite: 'Lax',
      secure: true,
      httpOnly: true,
      partitioned: false,
      other: [{ name: 'Priority', value: 'High' }],
    });
    expect(splitFoldedSetCookie('a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, b=2; Path=/')).toEqual(['a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT', 'b=2; Path=/']);
    expect(responseCookies([['Set-Cookie', 'a=1'], ['set-cookie', 'b=2; Max-Age=60']]).map((c) => [c.name, c.maxAge])).toEqual([
      ['a', undefined],
      ['b', '60'],
    ]);
  });
  it('decodes UTF-8 escapes for display but keeps reserved ones', () => {
    expect(displayUrl('/v1/search?q=k%C4%B1rlang%C4%B1%C3%A7&x=a%26b%2Fc')).toBe('/v1/search?q=kırlangıç&x=a%26b%2Fc');
    expect(displayUrl('/bad/%E0%A4')).toBe('/bad/%E0%A4');
    expect(displayUrl('/plain')).toBe('/plain');
  });
  it('reason phrases and file stems', () => {
    expect(reasonPhrase(422)).toBe('Unprocessable Content');
    expect(reasonPhrase(299)).toBeUndefined();
    expect(safeFileStem('api.pati.app', '/v1/pets/42?x=1')).toBe('api.pati.app-42');
  });
});
