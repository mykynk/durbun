import { STREAM_HEAD_KEPT, type NetworkEntry, type StreamInfo, type StreamMessage } from '@durbun/protocol';
import { isImportedDevice } from '../../../data/stores/hub';
import { base64ToBytes, hexDump } from './body';

/**
 * Stream entries (WebSocket, Server-Sent Events): one network entry per connection, its messages paged from the
 * server (data/streamMessages.ts). Pure helpers for the list cells and the Messages tab.
 */

export const isStreamEntry = (e: Pick<NetworkEntry, 'stream'>): boolean => e.stream !== undefined;

/** Short kind label (technical, same in both languages). */
export function streamKindLabel(kind: StreamInfo['kind'], short = false): string {
  if (kind === 'sse') return 'SSE';
  return short ? 'WS' : 'WebSocket';
}

/** When the connection opened: the 101 / SSE headers, else the handshake's end, else its start. */
export function streamOpenTs(e: Pick<NetworkEntry, 'startTs' | 'endTs' | 'stream'>): number {
  return e.stream?.openTs ?? e.endTs ?? e.startTs;
}

/** Open now: an imported recording's "open" connection was open when the file was saved, it does not run on. */
export function isLiveStream(e: Pick<NetworkEntry, 'deviceId' | 'stream'>): boolean {
  return e.stream?.state === 'open' && !isImportedDevice(e.deviceId);
}

/** How long the connection has been (live: until `now`) or was open (until it closed / its last message). */
export function streamAge(e: Pick<NetworkEntry, 'deviceId' | 'startTs' | 'endTs' | 'stream'>, now: number): number | undefined {
  const s = e.stream;
  if (!s) return undefined;
  const open = streamOpenTs(e);
  const end = isLiveStream(e) ? now : (s.closedTs ?? s.lastTs ?? open);
  return Math.max(0, end - open);
}

/**
 * A connection's age for the narrow Time column: from 10 minutes on whole minutes ("12 dk", "12m"), under that and
 * from an hour on what formatDuration gives (`full` is the exact text for the tooltip).
 */
export function compactAge(ms: number, tr: boolean, full: (ms: number) => string): string {
  if (ms >= 600_000 && ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    return tr ? `${m} dk` : `${m}m`;
  }
  return full(ms);
}

/* ───────────── Close codes (RFC 6455 §7.4, IANA registry) ───────────── */

const CLOSE_CODES: Record<number, string> = {
  1000: 'normal',
  1001: 'goingAway',
  1002: 'protocolError',
  1003: 'unsupportedData',
  1005: 'noStatus',
  1006: 'abnormal',
  1007: 'invalidData',
  1008: 'policy',
  1009: 'tooBig',
  1010: 'extension',
  1011: 'serverError',
  1012: 'restart',
  1013: 'tryAgain',
  1014: 'badGateway',
  1015: 'tls',
};
export const CLOSE_CODE_KEYS: readonly string[] = [...Object.values(CLOSE_CODES), 'library', 'app'];

/** i18n key part of a close code: a well-known one, 3000–3999 (libraries, frameworks), 4000–4999 (the app's own). */
export function closeCodeKey(code: number | undefined): string | null {
  if (code === undefined) return null;
  if (CLOSE_CODES[code]) return CLOSE_CODES[code]!;
  if (code >= 3000 && code <= 3999) return 'library';
  if (code >= 4000 && code <= 4999) return 'app';
  return null;
}

/* ───────────── Message text ───────────── */

/** The app-side error the server gives open streams of an app that left (server hub/network.ts STREAM_APP_GONE). */
export const STREAM_APP_GONE = 'The app disconnected';

const textCache = new WeakMap<StreamMessage, string | null>();

/** The payload as text (utf8 bodies), or null (binary, none). */
export function messageText(m: StreamMessage): string | null {
  if (textCache.has(m)) return textCache.get(m)!;
  const out = m.body && m.body.encoding === 'utf8' ? m.body.data : null;
  textCache.set(m, out);
  return out;
}

const bytesCache = new WeakMap<StreamMessage, Uint8Array | null>();

/** Raw payload bytes of a base64 body (binary frames), or null. */
export function messageBytes(m: StreamMessage): Uint8Array | null {
  if (bytesCache.has(m)) return bytesCache.get(m)!;
  let out: Uint8Array | null = null;
  if (m.body?.encoding === 'base64') {
    try {
      out = base64ToBytes(m.body.data);
    } catch {
      out = null;
    }
  }
  bytesCache.set(m, out);
  return out;
}

/** Bytes held of a payload (a cut payload holds less than `size`). */
export function heldBytes(m: StreamMessage): number {
  if (!m.body) return 0;
  return m.body.encoding === 'base64' ? (messageBytes(m)?.length ?? 0) : new TextEncoder().encode(m.body.data).length;
}

const PREVIEW_CHARS = 240;
const previewCache = new WeakMap<StreamMessage, string>();

/** One line for the list: whitespace collapsed; binary as the first bytes in hex; close as code and reason. */
export function messagePreview(m: StreamMessage): string {
  const hit = previewCache.get(m);
  if (hit !== undefined) return hit;
  let out = '';
  if (m.type === 'close') {
    out = [m.closeCode !== undefined ? String(m.closeCode) : '', m.closeReason ?? ''].filter(Boolean).join(' · ');
  } else if (m.body?.encoding === 'base64') {
    const bytes = messageBytes(m);
    if (bytes) {
      const head = Array.from(bytes.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join(' ');
      out = bytes.length > 16 ? `${head} …` : head;
    }
  } else {
    const text = messageText(m);
    if (text) out = text.slice(0, PREVIEW_CHARS * 2).replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
  }
  previewCache.set(m, out);
  return out;
}

/** The type chip: the opcode, or the SSE event name ("message" when the event had none). */
export function messageTypeLabel(m: StreamMessage): string {
  if (m.type === 'event') return m.event || 'message';
  return m.type;
}

export const isControl = (m: Pick<StreamMessage, 'type'>): boolean => m.type === 'ping' || m.type === 'pong';

/** Text the search looks in (lower case): payload text, close reason / code, SSE event name and id. */
function searchText(m: StreamMessage): string {
  return [messageText(m) ?? '', m.closeReason ?? '', m.closeCode !== undefined ? String(m.closeCode) : '', m.event ?? '', m.eventId ?? '', m.type === 'event' ? '' : m.type]
    .join('\n')
    .toLowerCase();
}

/** Pretty JSON of a text payload, or null when it is not (complete) JSON. */
export function jsonOf(text: string | null): { value: unknown } | null {
  if (!text) return null;
  const t = text.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

/** Hex dump of a binary payload (at most `limit` bytes). */
export function messageHex(m: StreamMessage, limit = 4096): string | null {
  const bytes = messageBytes(m);
  if (!bytes) return null;
  return hexDump(bytes, 0, Math.min(bytes.length, limit));
}

/** What "Copy payload" copies: the text, or base64 for a binary payload. */
export function payloadForCopy(m: StreamMessage): string | null {
  if (!m.body) return null;
  return m.body.data;
}

/** The message as JSON (the server's shape), for "Copy as JSON". */
export function messageJson(m: StreamMessage): string {
  return JSON.stringify(m, null, 2);
}

/* ───────────── Filtering and rows ───────────── */

export type DirFilter = 'all' | 'in' | 'out';

export interface MessageFilter {
  dir: DirFilter;
  /** Hide ping / pong frames. */
  hideControl: boolean;
  /** Free text (case-insensitive). */
  text: string;
}

export const DEFAULT_MESSAGE_FILTER: MessageFilter = { dir: 'all', hideControl: true, text: '' };

export type MessageRow =
  | { kind: 'message'; key: string; message: StreamMessage }
  /** `count` messages after `afterSeq` were removed by the memory limits. `head`: right after the kept first messages. */
  | { kind: 'gap'; key: string; afterSeq: number; count: number; head: boolean };

export interface MessageRows {
  rows: MessageRow[];
  /** Messages shown. */
  shown: number;
  /** Ping / pong frames the filter hides (with the other filters applied). */
  hiddenControl: number;
  /** Messages the text matched (equals `shown` while a text is set). */
  matches: number;
  /** Messages hidden by the direction / text filters. */
  filteredOut: number;
}

/**
 * Rows of the Messages list in `seq` order: the messages the filter keeps, and a gap row wherever `seq` jumps
 * (messages the limits removed; shown even when filters are on, so the list never pretends to be complete).
 */
export function buildMessageRows(messages: readonly StreamMessage[], filter: MessageFilter): MessageRows {
  const needle = filter.text.trim().toLowerCase();
  const rows: MessageRow[] = [];
  let prev = 0;
  let shown = 0;
  let hiddenControl = 0;
  let filteredOut = 0;
  for (const m of messages) {
    if (m.seq > prev + 1) {
      const count = m.seq - prev - 1;
      rows.push({ kind: 'gap', key: `gap-${prev}`, afterSeq: prev, count, head: prev === STREAM_HEAD_KEPT });
    }
    prev = m.seq;
    if (filter.dir !== 'all' && m.dir !== filter.dir) {
      filteredOut++;
      continue;
    }
    if (needle && !searchText(m).includes(needle)) {
      filteredOut++;
      continue;
    }
    if (filter.hideControl && isControl(m)) {
      hiddenControl++;
      continue;
    }
    rows.push({ kind: 'message', key: `m-${m.seq}`, message: m });
    shown++;
  }
  // Nothing shown: gap rows alone say little, the view's empty state speaks instead.
  if (shown === 0) return { rows: [], shown, hiddenControl, matches: 0, filteredOut };
  return { rows, shown, hiddenControl, matches: needle ? shown : 0, filteredOut };
}

/** Messages the server holds for this window vs. what the stream counted (the rest were removed by limits). */
export function droppedCount(stream: Pick<StreamInfo, 'dropped'> | undefined): number {
  return Math.max(0, stream?.dropped ?? 0);
}

/** Direction filter options with their counts (from the stream's own totals, dropped ones included). */
export function directionCounts(stream: Pick<StreamInfo, 'in' | 'out' | 'count'> | undefined): Record<DirFilter, number> {
  return { all: stream?.count ?? 0, in: stream?.in ?? 0, out: stream?.out ?? 0 };
}
