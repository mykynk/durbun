import { afterEach, describe, expect, it } from 'vitest';
import {
  base64Decode,
  base64Encode,
  bodyFromBase64,
  bodyFromBlob,
  bodyFromBytes,
  bodyFromString,
  captureRequestBody,
  formDataSummary,
  isTextual,
  looksLikeText,
  truncateUtf8,
  utf8Decode,
  utf8Encode,
  utf8Length,
  readBlobPrefix,
} from '../src/body.js';
import { g } from '../src/util.js';

const CFG = { captureBodies: true, maxBodyBytes: 1_048_576 };
const SAMPLES = ['', 'hello', 'Dürbün ğüşiöç ĞÜŞİÖÇ', 'emoji 🔭🚀 and 中文', '\u0000\u0001 control', 'a'.repeat(10_000)];

describe('UTF-8', () => {
  it('encodes and decodes like Buffer (TextEncoder path and manual path)', () => {
    for (const s of SAMPLES) {
      expect(Buffer.from(utf8Encode(s)).equals(Buffer.from(s, 'utf8'))).toBe(true);
      expect(utf8Length(s)).toBe(Buffer.byteLength(s, 'utf8'));
      expect(utf8Decode(Buffer.from(s, 'utf8'))).toBe(s);
    }
  });

  describe('without TextEncoder/TextDecoder (old Hermes)', () => {
    const TE = g.TextEncoder;
    const TD = g.TextDecoder;
    afterEach(() => {
      g.TextEncoder = TE;
      g.TextDecoder = TD;
    });
    it('manual codec matches Buffer, including lone surrogates and invalid bytes', () => {
      g.TextEncoder = undefined;
      g.TextDecoder = undefined;
      for (const s of [...SAMPLES, 'lone \ud83d surrogate']) {
        expect(Buffer.from(utf8Encode(s)).equals(Buffer.from(s, 'utf8')), s).toBe(true);
        expect(utf8Length(s)).toBe(Buffer.byteLength(s, 'utf8'));
      }
      for (const s of SAMPLES) expect(utf8Decode(Buffer.from(s, 'utf8'))).toBe(s);
      const invalid = Buffer.from([0x61, 0xff, 0xc3, 0x28, 0xe2, 0x82, 0x62, 0xf0, 0x9f, 0x94, 0xad]);
      expect(utf8Decode(invalid)).toBe(invalid.toString('utf8'));
    });
  });

  it('truncateUtf8 never splits a character', () => {
    const s = 'aç🔭b';
    // bytes: a(1) ç(2) 🔭(4) b(1)
    expect(truncateUtf8(s, 0)).toBe('');
    expect(truncateUtf8(s, 1)).toBe('a');
    expect(truncateUtf8(s, 2)).toBe('a');
    expect(truncateUtf8(s, 3)).toBe('aç');
    expect(truncateUtf8(s, 6)).toBe('aç');
    expect(truncateUtf8(s, 7)).toBe('aç🔭');
    expect(truncateUtf8(s, 100)).toBe(s);
  });
});

describe('base64', () => {
  it('matches Buffer for every length 0..300 and random data', () => {
    for (let n = 0; n <= 300; n++) {
      const bytes = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff));
      expect(base64Encode(bytes)).toBe(bytes.toString('base64'));
      expect(Buffer.from(base64Decode(bytes.toString('base64'))).equals(bytes)).toBe(true);
    }
    const big = Buffer.alloc(200_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 0xff;
    expect(base64Encode(big)).toBe(big.toString('base64'));
  });

  it('decodes URL-safe alphabet, whitespace and missing padding', () => {
    const bytes = Buffer.from([0xfb, 0xff, 0xbf, 0x01]);
    const urlSafe = bytes.toString('base64url');
    expect(Buffer.from(base64Decode(urlSafe)).equals(bytes)).toBe(true);
    expect(Buffer.from(base64Decode(' +/+/\nAQ== ')).equals(Buffer.from('+/+/AQ==', 'base64'))).toBe(true);
  });
});

describe('text detection', () => {
  it('uses the protocol rule, charset parameters and sniffing when the type is unknown', () => {
    expect(isTextual('application/json')).toBe(true);
    expect(isTextual('application/problem+json')).toBe(true);
    expect(isTextual('application/x-custom; charset=utf-8')).toBe(true);
    expect(isTextual('image/png')).toBe(false);
    expect(isTextual('application/octet-stream')).toBe(false);
    expect(isTextual(undefined, Buffer.from('{"a":1}'))).toBe(true);
    expect(isTextual(undefined, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe(false);
    expect(looksLikeText(Buffer.from('satır 1\nsatır 2\t✓'))).toBe(true);
    expect(looksLikeText(Buffer.from([0x61, 0x00, 0x62]))).toBe(false);
  });
});

describe('WireBody builders', () => {
  it('text within the limit is sent as-is with its byte size', () => {
    expect(bodyFromString('{"ok":true,"ad":"Ayşe"}', 'application/json', CFG)).toEqual({ encoding: 'utf8', data: '{"ok":true,"ad":"Ayşe"}', size: 24 });
  });

  it('truncates at maxBodyBytes but keeps the real size', () => {
    const body = bodyFromString('ğ'.repeat(100), 'text/plain', { captureBodies: true, maxBodyBytes: 11 });
    expect(body).toEqual({ encoding: 'utf8', data: 'ğ'.repeat(5), size: 200, truncated: true });
  });

  it('binary bytes become base64 (truncated prefix when too large)', () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    expect(bodyFromBytes(bytes, 'image/png', CFG)).toEqual({ encoding: 'base64', data: bytes.toString('base64'), size: 256 });
    const cut = bodyFromBytes(bytes, 'image/png', { captureBodies: true, maxBodyBytes: 10 });
    expect(cut).toEqual({ encoding: 'base64', data: bytes.subarray(0, 10).toString('base64'), size: 256, truncated: true });
  });

  it('text bytes are decoded without splitting a multi-byte character', () => {
    const bytes = Buffer.from('aç🔭b', 'utf8');
    expect(bodyFromBytes(bytes, 'text/plain', { captureBodies: true, maxBodyBytes: 5 })).toEqual({ encoding: 'utf8', data: 'aç', size: 8, truncated: true });
  });

  it('captureBodies=false reports only the size', () => {
    expect(bodyFromString('hello', 'text/plain', { captureBodies: false, maxBodyBytes: 100 })).toEqual({ encoding: 'utf8', data: '', size: 5, truncated: true });
  });

  it('base64 input: binary passes through, text is decoded', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    expect(bodyFromBase64(png.toString('base64'), 'image/png', CFG)).toEqual({ encoding: 'base64', data: png.toString('base64'), size: 4 });
    expect(bodyFromBase64(Buffer.from('{"a":"ş"}').toString('base64'), 'application/json', CFG)).toEqual({ encoding: 'utf8', data: '{"a":"ş"}', size: 10 });
    // prefix of a larger blob
    expect(bodyFromBase64(png.toString('base64'), 'image/png', CFG, 1000)).toEqual({ encoding: 'base64', data: png.toString('base64'), size: 1000, truncated: true });
  });
});

describe('request bodies', () => {
  it('captures strings, URLSearchParams, ArrayBuffer and typed arrays synchronously', () => {
    expect(captureRequestBody('{"x":1}', 'application/json', CFG)).toEqual({ encoding: 'utf8', data: '{"x":1}', size: 7 });
    expect(captureRequestBody(new URLSearchParams({ q: 'dürbün', page: '2' }), undefined, CFG)).toEqual({
      encoding: 'utf8',
      data: 'q=d%C3%BCrb%C3%BCn&page=2',
      size: 25,
    });
    const ab = new Uint8Array([1, 2, 3]).buffer;
    expect(captureRequestBody(ab, 'application/octet-stream', CFG)).toEqual({ encoding: 'base64', data: 'AQID', size: 3 });
    expect(captureRequestBody(new Uint8Array([104, 105]), 'text/plain', CFG)).toEqual({ encoding: 'utf8', data: 'hi', size: 2 });
    expect(captureRequestBody(null, undefined, CFG)).toBeUndefined();
    expect(captureRequestBody('', 'text/plain', CFG)).toBeUndefined();
  });

  it('never consumes streams', () => {
    const stream = new ReadableStream({ start: (c) => c.close() });
    expect(captureRequestBody(stream, 'application/json', CFG)).toBeUndefined();
    expect(stream.locked).toBe(false);
  });

  it('reads Blobs asynchronously (only the needed prefix)', async () => {
    const blob = new Blob(['{"big":"', 'x'.repeat(100), '"}'], { type: 'application/json' });
    const body = await bodyFromBlob(blob, undefined, { captureBodies: true, maxBodyBytes: 10 });
    expect(body).toEqual({ encoding: 'utf8', data: '{"big":"xx', size: blob.size, truncated: true });
    const res = captureRequestBody(new Blob([new Uint8Array([0, 1, 2])]), 'application/octet-stream', CFG);
    await expect(res).resolves.toEqual({ encoding: 'base64', data: 'AAEC', size: 3 });
  });

  it('reads React Native style Blobs through FileReader.readAsDataURL', async () => {
    const FR = g.FileReader;
    try {
      // RN Blob: no arrayBuffer(); FileReader returns a data URL.
      g.FileReader = class {
        result: string | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL(blob: { _data: Buffer; type: string }) {
          setTimeout(() => {
            this.result = `data:${blob.type || 'application/octet-stream'};base64,${blob._data.toString('base64')}`;
            this.onload?.();
          }, 1);
        }
      };
      const data = Buffer.from('{"rn":true}');
      const rnBlob = {
        _data: data,
        size: data.length,
        type: 'application/json',
        slice(start: number, end: number) {
          return { ...rnBlob, _data: data.subarray(start, end), size: Math.min(end, data.length) - start };
        },
      };
      expect(await readBlobPrefix(rnBlob, 100)).toEqual({ base64: data.toString('base64') });
      expect(await bodyFromBlob(rnBlob, undefined, CFG)).toEqual({ encoding: 'utf8', data: '{"rn":true}', size: 11 });
      expect(await bodyFromBlob(rnBlob, undefined, { captureBodies: true, maxBodyBytes: 4 })).toEqual({ encoding: 'utf8', data: '{"rn', size: 11, truncated: true });
    } finally {
      g.FileReader = FR;
    }
  });

  it('summarizes FormData (web and React Native) as readable JSON', () => {
    const fd = new FormData();
    fd.append('name', 'Yusuf');
    fd.append('tags', 'a');
    fd.append('tags', 'b');
    fd.append('avatar', new File([new Uint8Array(1234)], 'photo.jpg', { type: 'image/jpeg' }));
    expect(JSON.parse(formDataSummary(fd))).toEqual({
      name: 'Yusuf',
      tags: ['a', 'b'],
      avatar: { file: 'photo.jpg', type: 'image/jpeg', size: 1234 },
    });
    const rnForm = {
      _parts: [
        ['username', 'yusuf'],
        ['photo', { uri: 'file:///data/user/0/com.app/cache/IMG_1.jpg', name: 'IMG_1.jpg', type: 'image/jpeg' }],
      ],
      append() {},
      getParts() {
        return [];
      },
    };
    expect(JSON.parse(formDataSummary(rnForm))).toEqual({
      username: 'yusuf',
      photo: { file: 'IMG_1.jpg', type: 'image/jpeg', uri: 'file:///data/user/0/com.app/cache/IMG_1.jpg' },
    });
    const captured = captureRequestBody(rnForm, 'multipart/form-data', CFG);
    expect(captured).toMatchObject({ encoding: 'utf8' });
    expect(JSON.parse((captured as { data: string }).data).username).toBe('yusuf');
  });
});
