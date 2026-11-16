/**
 * Building blocks of the stream capture: the incremental Server-Sent Events parser (every chunking of a
 * stream gives the same events), streaming UTF-8 decoding, payload caps, and the lane that keeps a
 * connection's messages in order while Blob payloads are read.
 */
import { describe, expect, it } from 'vitest';
import {
  binaryBytes,
  blobPayload,
  bytesPayload,
  closeFrameSize,
  isEventStream,
  SseParser,
  SseTap,
  sseMessage,
  StreamLane,
  textPayload,
  Utf8Stream,
  type SseEvent,
} from '../src/streams.js';

function parseAll(chunks: string[], keep?: () => number): SseEvent[] {
  const events: SseEvent[] = [];
  const parser = new SseParser((e) => events.push(e), keep);
  for (const c of chunks) parser.feed(c);
  return events;
}

/** Every way to cut `text` in two, plus one chunk per character. */
function chunkings(text: string): string[][] {
  const out: string[][] = [[text], text.split('')];
  for (let i = 1; i < text.length; i++) out.push([text.slice(0, i), text.slice(i)]);
  return out;
}

const STREAM = [
  '﻿: welcome comment\r\n',
  'retry: 2500\r\n',
  'id: 41\r\n',
  'event: queue\r\n',
  'data: {"position":3}\r\n',
  '\r\n',
  'data: first line\n',
  'data:second line\n',
  'data\n',
  '\n',
  'id: bad\u0000id\n',
  'retry: 12s\n',
  'data: ğüş 🔭\r',
  '\r',
  'event: message\n',
  'data: plain\n',
  'unknown: field\n',
  '\n',
  'id: 77\n',
  '\n',
  'data: never dispatched',
].join('');

const EXPECTED: SseEvent[] = [
  { event: 'queue', data: '{"position":3}', size: 14, id: '41', retry: 2500 },
  { data: 'first line\nsecond line\n', size: 23 },
  { data: 'ğüş 🔭', size: 11 },
  { data: 'plain', size: 5 },
];

describe('SseParser', () => {
  it('parses fields, comments, BOM, CRLF / LF / CR and skips what EventSource skips', () => {
    expect(parseAll([STREAM])).toEqual(EXPECTED);
  });

  it('gives the same events for every chunking (line endings and fields split anywhere)', () => {
    for (const chunks of chunkings(STREAM)) expect(parseAll(chunks), JSON.stringify(chunks.slice(0, 2))).toEqual(EXPECTED);
  });

  it('a CR at the end of a chunk followed by LF is one line end', () => {
    expect(parseAll(['data: a\r', '\n\r', '\n'])).toEqual([{ data: 'a', size: 1 }]);
    // CR CR: two line ends, the second is the empty line.
    expect(parseAll(['data: b\r', '\r'])).toEqual([{ data: 'b', size: 1 }]);
  });

  it('an empty data field dispatches an empty event; no data field dispatches nothing', () => {
    expect(parseAll(['data:\n\n'])).toEqual([{ data: '', size: 0 }]);
    expect(parseAll(['event: ping\nid: 3\nretry: 10\n\n'])).toEqual([]);
    // The fields of an undispatched block do not leak into the next event.
    expect(parseAll(['event: ping\n\ndata: x\n\n'])).toEqual([{ data: 'x', size: 1 }]);
  });

  it('an event left without its final empty line is not dispatched', () => {
    expect(parseAll(['data: one\n\ndata: two\n'])).toEqual([{ data: 'one', size: 3 }]);
  });

  it('keeps only `keep()` characters of the data but counts the full UTF-8 size', () => {
    const events = parseAll(['data: ', 'ş'.repeat(50), '\ndata: tail\n\n'], () => 10);
    expect(events).toEqual([{ data: 'ş'.repeat(10), size: 100 + 1 + 4, cut: true }]);
    expect(parseAll(['data: abc\n\n'], () => 0)).toEqual([{ data: '', size: 3, cut: true }]);
  });
});

describe('Utf8Stream', () => {
  it('decodes characters split across chunks at every byte position', () => {
    const text = 'aş€🔭z';
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i <= bytes.length; i++) {
      for (let j = i; j <= bytes.length; j++) {
        const d = new Utf8Stream();
        const out = d.decode(bytes.subarray(0, i)) + d.decode(bytes.subarray(i, j)) + d.decode(bytes.subarray(j));
        expect(out, `${i}/${j}`).toBe(text);
      }
    }
  });
});

describe('payloads', () => {
  it('text: full size, cut at the cap without splitting a character, none at cap 0', () => {
    expect(textPayload('merhaba', 100)).toEqual({ size: 7, body: { encoding: 'utf8', data: 'merhaba', size: 7 } });
    expect(textPayload('ğğğ', 5)).toEqual({ size: 6, body: { encoding: 'utf8', data: 'ğğ', size: 6, truncated: true } });
    expect(textPayload('abc', 0)).toEqual({ size: 3 });
    expect(textPayload('', 10)).toEqual({ size: 0 });
  });

  it('binary: base64, cut at the cap', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    expect(bytesPayload(bytes, 100)).toEqual({ size: 6, body: { encoding: 'base64', data: 'AAEC+vv8', size: 6 } });
    expect(bytesPayload(bytes, 3)).toEqual({ size: 6, body: { encoding: 'base64', data: 'AAEC', size: 6, truncated: true } });
    expect(bytesPayload(bytes, 0)).toEqual({ size: 6 });
  });

  it('binaryBytes reads ArrayBuffers, views at an offset, Node Buffers and fragment lists', () => {
    const buf = new Uint8Array([9, 8, 7, 6]).buffer;
    expect([...binaryBytes(buf)!]).toEqual([9, 8, 7, 6]);
    expect([...binaryBytes(new DataView(buf, 1, 2))!]).toEqual([8, 7]);
    expect([...binaryBytes(Buffer.from([1, 2]))!]).toEqual([1, 2]);
    expect([...binaryBytes([Buffer.from([1]), new Uint8Array([2, 3])])!]).toEqual([1, 2, 3]);
    expect(binaryBytes('text')).toBeUndefined();
  });

  it('Blob: size at once, a prefix read without consuming it', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5])]);
    expect(blobPayload(blob, 0)).toEqual({ size: 5 });
    expect(await blobPayload(blob, 3)).toEqual({ size: 5, body: { encoding: 'base64', data: 'AQID', size: 5, truncated: true } });
    // Still readable by the app afterwards.
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
  });

  it('close frames: 2 bytes of code plus the reason', () => {
    expect(closeFrameSize({})).toBe(0);
    expect(closeFrameSize({ code: 1000 })).toBe(2);
    expect(closeFrameSize({ code: 4000, reason: 'güle' })).toBe(7);
  });

  it('sseMessage caps the data and keeps the event fields', () => {
    expect(sseMessage('9', 1, { event: 'tick', data: 'abcdef', size: 6, id: '5', retry: 100 }, 4)).toEqual({
      type: 'net.sse',
      id: '9',
      ts: 1,
      size: 6,
      event: 'tick',
      eventId: '5',
      retry: 100,
      body: { encoding: 'utf8', data: 'abcd', size: 6, truncated: true },
    });
    expect(sseMessage('9', 1, { data: 'abc', size: 3 }, 0)).toEqual({ type: 'net.sse', id: '9', ts: 1, size: 3 });
    expect(sseMessage('9', 1, { data: '', size: 0, id: '' }, 10)).toEqual({ type: 'net.sse', id: '9', ts: 1, size: 0, eventId: '' });
  });

  it('isEventStream', () => {
    expect(isEventStream('text/event-stream')).toBe(true);
    expect(isEventStream(' Text/Event-Stream; charset=utf-8')).toBe(true);
    expect(isEventStream('application/x-ndjson')).toBe(false);
    expect(isEventStream(undefined)).toBe(false);
  });
});

describe('SseTap', () => {
  it('sends events while the host asks for streams, and one end', () => {
    let cap: number | undefined = 100;
    const sent: any[] = [];
    const tap = new SseTap({ streamCapture: () => cap, debug: () => undefined }, '7', (m) => sent.push(m));
    tap.bytes(new TextEncoder().encode('data: a\n\n'));
    cap = undefined;
    tap.text('data: b\n\n');
    cap = 2;
    tap.text('data: cde\n\n');
    tap.end();
    tap.cancel();
    expect(sent.map((m) => ({ ...m, ts: 0 }))).toEqual([
      { type: 'net.sse', id: '7', ts: 0, size: 1, body: { encoding: 'utf8', data: 'a', size: 1 } },
      { type: 'net.sse', id: '7', ts: 0, size: 3, body: { encoding: 'utf8', data: 'cd', size: 3, truncated: true } },
      { type: 'net.sse', id: '7', ts: 0, end: true },
    ]);
  });

  it('cancel and failure end the stream with net.error', () => {
    const sent: any[] = [];
    const host = { streamCapture: () => 10, debug: () => undefined };
    new SseTap(host, '1', (m) => sent.push(m)).cancel();
    new SseTap(host, '2', (m) => sent.push(m)).fail('Network request failed');
    expect(sent.map((m) => ({ ...m, ts: 0 }))).toEqual([
      { type: 'net.error', id: '1', ts: 0, error: 'Stream closed by the app', cancelled: true },
      { type: 'net.error', id: '2', ts: 0, error: 'Network request failed' },
    ]);
  });
});

describe('StreamLane', () => {
  it('emits at once when nothing is pending and keeps order behind pending reads', async () => {
    const out: string[] = [];
    const lane = new StreamLane((m) => out.push((m as any).tag));
    const msg = (tag: string) => ({ type: 'net.ws', tag }) as any;
    lane.push(msg('a'));
    expect(out).toEqual(['a']);
    let releaseSlow!: () => void;
    const slow = new Promise<any>((r) => (releaseSlow = () => r(msg('slow'))));
    lane.push(slow);
    lane.push(Promise.resolve(msg('fast')));
    lane.push(msg('b'));
    await new Promise((r) => setTimeout(r, 5));
    expect(out).toEqual(['a']);
    expect(lane.pending).toBe(3);
    releaseSlow();
    await new Promise((r) => setTimeout(r, 5));
    expect(out).toEqual(['a', 'slow', 'fast', 'b']);
    expect(lane.pending).toBe(0);
    // A failed read leaves no hole in the order.
    lane.push(Promise.reject(new Error('x')));
    lane.push(msg('c'));
    await new Promise((r) => setTimeout(r, 5));
    expect(out).toEqual(['a', 'slow', 'fast', 'b', 'c']);
  });
});
