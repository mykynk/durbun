import { describe, expect, it } from 'vitest';
import { STREAM_HEAD_KEPT, type NetworkEntry, type StreamInfo, type StreamMessage } from '@durbun/protocol';
import {
  DEFAULT_MESSAGE_FILTER,
  buildMessageRows,
  closeCodeKey,
  compactAge,
  heldBytes,
  isLiveStream,
  messageHex,
  messagePreview,
  messageTypeLabel,
  payloadForCopy,
  streamAge,
} from './streams';

const text = (seq: number, data: string, p: Partial<StreamMessage> = {}): StreamMessage => ({
  seq,
  ts: 1000 + seq,
  dir: 'in',
  type: 'text',
  size: data.length,
  body: { encoding: 'utf8', data, size: data.length },
  ...p,
});
const ping = (seq: number, dir: 'in' | 'out' = 'out'): StreamMessage => ({ seq, ts: 1000 + seq, dir, type: 'ping', size: 0 });

const info = (p: Partial<StreamInfo> = {}): StreamInfo => ({
  kind: 'websocket',
  state: 'open',
  openTs: 1_000,
  count: 0,
  in: 0,
  out: 0,
  control: 0,
  bytesIn: 0,
  bytesOut: 0,
  dropped: 0,
  lastSeq: 0,
  ...p,
});
const entry = (stream: StreamInfo | undefined, deviceId = 'android:1'): Pick<NetworkEntry, 'deviceId' | 'startTs' | 'endTs' | 'stream'> => ({
  deviceId,
  startTs: 900,
  endTs: 1_000,
  ...(stream ? { stream } : {}),
});

describe('buildMessageRows', () => {
  it('keeps seq order and puts a gap row where seq jumps, marking the one after the kept head', () => {
    const head = Array.from({ length: STREAM_HEAD_KEPT }, (_, i) => text(i + 1, `m${i + 1}`));
    const r = buildMessageRows([...head, text(STREAM_HEAD_KEPT + 41, 'late'), text(STREAM_HEAD_KEPT + 43, 'later')], DEFAULT_MESSAGE_FILTER);
    const gaps = r.rows.filter((x) => x.kind === 'gap');
    expect(gaps).toEqual([
      { kind: 'gap', key: `gap-${STREAM_HEAD_KEPT}`, afterSeq: STREAM_HEAD_KEPT, count: 40, head: true },
      { kind: 'gap', key: `gap-${STREAM_HEAD_KEPT + 41}`, afterSeq: STREAM_HEAD_KEPT + 41, count: 1, head: false },
    ]);
    expect(r.shown).toBe(STREAM_HEAD_KEPT + 2);
    expect(r.rows.at(-1)).toMatchObject({ kind: 'message', key: `m-${STREAM_HEAD_KEPT + 43}` });
  });

  it('hides ping / pong by default and counts them; shows them when asked', () => {
    const msgs = [text(1, 'a'), ping(2), ping(3, 'in'), text(4, 'b')];
    const hidden = buildMessageRows(msgs, DEFAULT_MESSAGE_FILTER);
    expect(hidden.shown).toBe(2);
    expect(hidden.hiddenControl).toBe(2);
    const all = buildMessageRows(msgs, { ...DEFAULT_MESSAGE_FILTER, hideControl: false });
    expect(all.shown).toBe(4);
    expect(all.hiddenControl).toBe(0);
  });

  it('filters by direction and text; counts matches, case-insensitive, in payload, close reason and SSE fields', () => {
    const msgs = [
      text(1, '{"type":"Auth"}', { dir: 'out' }),
      text(2, '{"type":"auth.ok"}'),
      { seq: 3, ts: 1003, dir: 'in', type: 'close', size: 2, closeCode: 1001, closeReason: 'Server restarting' } as StreamMessage,
      text(4, '{"position":3}', { type: 'event', event: 'queue', eventId: 'q-7' }),
    ];
    expect(buildMessageRows(msgs, { ...DEFAULT_MESSAGE_FILTER, dir: 'out' }).rows.map((r) => r.key)).toEqual(['m-1']);
    const auth = buildMessageRows(msgs, { ...DEFAULT_MESSAGE_FILTER, text: 'AUTH' });
    expect(auth.matches).toBe(2);
    expect(auth.filteredOut).toBe(2);
    expect(buildMessageRows(msgs, { ...DEFAULT_MESSAGE_FILTER, text: 'restarting' }).rows.map((r) => r.key)).toEqual(['m-3']);
    expect(buildMessageRows(msgs, { ...DEFAULT_MESSAGE_FILTER, text: '1001' }).shown).toBe(1);
    expect(buildMessageRows(msgs, { ...DEFAULT_MESSAGE_FILTER, text: 'q-7' }).rows.map((r) => r.key)).toEqual(['m-4']);
    expect(buildMessageRows(msgs, DEFAULT_MESSAGE_FILTER).matches).toBe(0);
  });

  it('returns no rows (not lone gap rows) when nothing is shown', () => {
    const r = buildMessageRows([text(1, 'a'), text(5, 'b')], { ...DEFAULT_MESSAGE_FILTER, text: 'zzz' });
    expect(r.rows).toEqual([]);
    expect(r.shown).toBe(0);
    expect(r.filteredOut).toBe(2);
  });
});

describe('message helpers', () => {
  it('previews text on one line, binary as hex, close as code and reason', () => {
    expect(messagePreview(text(1, '{\n  "a": 1,\n  "b": 2\n}'))).toBe('{ "a": 1, "b": 2 }');
    expect(messagePreview(text(2, 'x'.repeat(1000)))).toHaveLength(240);
    const bin: StreamMessage = { seq: 3, ts: 1, dir: 'in', type: 'binary', size: 20, body: { encoding: 'base64', data: btoa(String.fromCharCode(...Array.from({ length: 20 }, (_, i) => i))), size: 20 } };
    expect(messagePreview(bin)).toBe('00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f …');
    expect(messageHex(bin)).toContain('00 01 02 03');
    expect(heldBytes(bin)).toBe(20);
    expect(payloadForCopy(bin)).toBe(bin.body!.data);
    expect(messagePreview({ seq: 4, ts: 1, dir: 'out', type: 'close', size: 2, closeCode: 1000, closeReason: 'bye' })).toBe('1000 · bye');
  });

  it('names the type chip: opcode, SSE event name, "message" for an unnamed event', () => {
    expect(messageTypeLabel(text(1, 'a'))).toBe('text');
    expect(messageTypeLabel(text(2, 'a', { type: 'event', event: 'queue' }))).toBe('queue');
    expect(messageTypeLabel(text(3, 'a', { type: 'event' }))).toBe('message');
  });

  it('maps close codes to names, library and app ranges', () => {
    expect(closeCodeKey(1000)).toBe('normal');
    expect(closeCodeKey(1001)).toBe('goingAway');
    expect(closeCodeKey(1006)).toBe('abnormal');
    expect(closeCodeKey(3003)).toBe('library');
    expect(closeCodeKey(4401)).toBe('app');
    expect(closeCodeKey(1004)).toBeNull();
    expect(closeCodeKey(undefined)).toBeNull();
  });
});

describe('connection age', () => {
  it('runs until now while live; stops at close, else at the last message', () => {
    expect(streamAge(entry(info()), 61_000)).toBe(60_000);
    expect(streamAge(entry(info({ state: 'closed', closedTs: 5_000 })), 61_000)).toBe(4_000);
    expect(streamAge(entry(info({ state: 'failed', lastTs: 3_000 })), 61_000)).toBe(2_000);
    expect(streamAge(entry(undefined), 61_000)).toBeUndefined();
  });

  it('an imported recording is not live: its "open" connection stops at the last message', () => {
    const imported = entry(info({ lastTs: 9_000 }), 'import:3');
    expect(isLiveStream(imported)).toBe(false);
    expect(isLiveStream(entry(info()))).toBe(true);
    expect(streamAge(imported, 61_000)).toBe(8_000);
  });

  it('compacts 10–59 minutes to whole minutes for the narrow column', () => {
    const full = (ms: number) => `${ms}ms`;
    expect(compactAge(742_000, true, full)).toBe('12 dk');
    expect(compactAge(742_000, false, full)).toBe('12m');
    expect(compactAge(59_000, false, full)).toBe('59000ms');
    expect(compactAge(3_700_000, false, full)).toBe('3700000ms');
  });
});
