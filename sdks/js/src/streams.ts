/**
 * Shared pieces of the stream capture (WebSocket messages and Server-Sent Events, SPEC §6.1.1): payloads capped
 * at `config.maxStreamMessageBytes`, an incremental Server-Sent Events parser, the tap that turns an event
 * stream into `net.sse` messages, a per-connection lane that keeps messages in the app's order while a Blob is
 * read, and the subclassing of a global constructor (`WebSocket`, `EventSource`).
 */
import {
  base64Decode,
  base64Encode,
  incompleteTailStart,
  isArrayBufferLike,
  isArrayBufferViewLike,
  readBlobPrefix,
  truncateUtf8,
  utf8Decode,
  utf8Encode,
  utf8Length,
  viewToBytes,
  type BlobLike,
} from './body.js';
import type { NetworkHost } from './network.js';
import { patchMethod, type Patch } from './patch.js';
import type { SdkNetError, SdkNetSse, SdkNetWs, WireBody } from './protocol.js';
import { errorMessage, g, isPromiseLike, type AnyRecord } from './util.js';

/** The desktop's validator keeps at most this many characters of `event`, `eventId` and `closeReason`. */
const SHORT_FIELD = 256;

/* ────────────────────────────── payloads ────────────────────────────── */

export interface Payload {
  /** Full payload size in bytes. */
  size: number;
  body?: WireBody;
}

/** A text payload (UTF-8), cut at `cap` bytes; `cap` 0 = size only. */
export function textPayload(text: string, cap: number): Payload {
  const size = utf8Length(text);
  if (cap <= 0 || size === 0) return { size };
  if (size <= cap) return { size, body: { encoding: 'utf8', data: text, size } };
  return { size, body: { encoding: 'utf8', data: truncateUtf8(text, cap), size, truncated: true } };
}

/** A binary payload (base64), cut at `cap` bytes; `cap` 0 = size only. */
export function bytesPayload(bytes: Uint8Array, cap: number, size = bytes.length): Payload {
  if (cap <= 0 || size === 0) return { size };
  const kept = bytes.length > cap ? bytes.subarray(0, cap) : bytes;
  const body: WireBody = { encoding: 'base64', data: base64Encode(kept), size };
  if (size > kept.length) body.truncated = true;
  return { size, body };
}

/** Bytes of an ArrayBuffer, a typed array / DataView / Node Buffer, or a list of them; undefined otherwise. */
export function binaryBytes(data: unknown): Uint8Array | undefined {
  if (isArrayBufferLike(data)) return new Uint8Array(data);
  if (isArrayBufferViewLike(data)) return viewToBytes(data);
  if (Array.isArray(data) && data.length > 0 && data.every((part) => isArrayBufferViewLike(part) || isArrayBufferLike(part))) {
    const parts = data.map((part) => binaryBytes(part) as Uint8Array);
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
  return undefined;
}

/**
 * A Blob payload: its size at once, its first `cap` bytes read without consuming it (arrayBuffer(), or
 * FileReader in React Native). Resolves with the size only when the Blob cannot be read.
 */
export function blobPayload(blob: BlobLike, cap: number): Payload | Promise<Payload> {
  const size = typeof blob.size === 'number' && blob.size >= 0 ? blob.size : 0;
  if (cap <= 0 || size === 0) return { size };
  return readBlobPrefix(blob, cap).then(
    (read): Payload => {
      if (read && read.bytes) return bytesPayload(read.bytes, cap, size);
      if (read && read.base64 !== undefined) {
        // A data URL of at most `cap` bytes (the Blob was sliced) passes through as it is.
        const plain = /^[A-Za-z0-9+/]*={0,2}$/.test(read.base64);
        if (plain && Math.floor((read.base64.length * 3) / 4) <= cap) {
          const body: WireBody = { encoding: 'base64', data: read.base64, size };
          if (size > cap) body.truncated = true;
          return { size, body };
        }
        return bytesPayload(base64Decode(read.base64), cap, size);
      }
      return { size };
    },
    (): Payload => ({ size }),
  );
}

/** `net.ws` for a payload; `extra` carries the close code and reason of a close frame. */
export function wsMessage(id: string, ts: number, dir: 'in' | 'out', opcode: SdkNetWs['opcode'], payload: Payload, extra?: CloseInfo): SdkNetWs {
  const msg: SdkNetWs = { type: 'net.ws', id, ts, dir, opcode, size: payload.size };
  if (payload.body) msg.body = payload.body;
  if (extra && extra.code !== undefined) msg.closeCode = extra.code;
  if (extra && extra.reason) msg.closeReason = extra.reason.slice(0, SHORT_FIELD);
  return msg;
}

export interface CloseInfo {
  code?: number;
  reason?: string;
}

/** Payload size of a close frame: 2 bytes of status code plus the UTF-8 reason (none without a code). */
export function closeFrameSize(info: CloseInfo): number {
  return info.code === undefined ? 0 : 2 + (info.reason ? utf8Length(info.reason) : 0);
}

/* ────────────────────────────── ordered emission ────────────────────────────── */

type LaneMessage = SdkNetWs | SdkNetSse | SdkNetError;

/**
 * Keeps one connection's messages in the order the app saw them although some payloads (Blobs) are read
 * asynchronously: a message waits behind the reads queued before it. Messages are emitted at once when
 * nothing is pending.
 */
export class StreamLane {
  private slots: Array<{ msg?: LaneMessage; pending: boolean }> = [];

  constructor(private readonly emit: (msg: LaneMessage) => void) {}

  /** Reads still in progress (callers fall back to sizes only past a limit: bounded memory). */
  get pending(): number {
    return this.slots.length;
  }

  push(msg: LaneMessage | Promise<LaneMessage>): void {
    if (isPromiseLike<LaneMessage>(msg)) {
      const slot: { msg?: LaneMessage; pending: boolean } = { pending: true };
      this.slots.push(slot);
      msg.then(
        (m) => this.settle(slot, m),
        () => this.settle(slot, undefined),
      );
      return;
    }
    if (this.slots.length === 0) this.emit(msg);
    else this.slots.push({ msg, pending: false });
  }

  private settle(slot: { msg?: LaneMessage; pending: boolean }, msg: LaneMessage | undefined): void {
    slot.msg = msg;
    slot.pending = false;
    while (this.slots.length > 0 && !this.slots[0].pending) {
      const head = this.slots.shift() as { msg?: LaneMessage };
      if (head.msg) {
        try {
          this.emit(head.msg);
        } catch {
          // the host swallows its own errors; never stop draining
        }
      }
    }
  }
}

/* ────────────────────────────── Server-Sent Events ────────────────────────────── */

/** True for `text/event-stream` (with or without parameters). */
export function isEventStream(contentType: string | undefined): boolean {
  return !!contentType && contentType.trim().toLowerCase().startsWith('text/event-stream');
}

export interface SseEvent {
  /** `event:` field; undefined for the default "message". */
  event?: string;
  /** `data:` lines joined with "\n" (at most `keep()` characters of it). */
  data: string;
  /** UTF-8 size of the whole data. */
  size: number;
  /** `data` holds only the start of the data (see the parser's `keep`). */
  cut?: boolean;
  /** `id:` field, when the event had one. */
  id?: string;
  /** `retry:` field (ms), when the event had a valid one. */
  retry?: number;
}

/** Characters kept of one line before the parser stops storing it (the size is still counted). */
const LINE_KEEP = 1024 * 1024;
const LINE_END = /[\r\n]/g;

/**
 * Incremental `text/event-stream` parser (WHATWG HTML "event stream interpretation"): lines end in CRLF, LF or
 * CR (also across chunks), `:` lines are comments, an empty line dispatches the event; `data` lines are joined
 * with "\n", `id` without NUL, `retry` digits only, a leading BOM is dropped. An event left without its final
 * empty line when the stream ends is not dispatched. Feed it decoded text in any chunking.
 */
export class SseParser {
  private partial = '';
  /** UTF-8 bytes of the current line that were not kept (very long lines). */
  private partialDropped = 0;
  private sawCR = false;
  private started = false;
  private dataParts: string[] = [];
  private dataLines = 0;
  private dataKept = 0;
  private dataBytes = 0;
  private dataCut = false;
  private eventType = '';
  private eventId: string | undefined;
  private retry: number | undefined;

  constructor(
    private readonly onEvent: (event: SseEvent) => void,
    /** Data characters to keep per event (the payload cap); the size is always complete. */
    private readonly keep: () => number = () => Infinity,
  ) {}

  feed(text: string): void {
    if (!text) return;
    if (!this.started) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    let pos = 0;
    if (this.sawCR) {
      this.sawCR = false;
      if (text.charCodeAt(0) === 10) pos = 1;
    }
    while (pos < text.length) {
      LINE_END.lastIndex = pos;
      const m = LINE_END.exec(text);
      if (!m) {
        this.append(text.slice(pos));
        return;
      }
      const end = m.index;
      this.append(text.slice(pos, end));
      const line = this.partial;
      const dropped = this.partialDropped;
      this.partial = '';
      this.partialDropped = 0;
      if (text.charCodeAt(end) === 13) {
        if (end + 1 >= text.length) this.sawCR = true;
        pos = end + 1 < text.length && text.charCodeAt(end + 1) === 10 ? end + 2 : end + 1;
      } else pos = end + 1;
      this.line(line, dropped);
    }
  }

  private append(s: string): void {
    if (!s) return;
    const room = LINE_KEEP - this.partial.length;
    if (s.length <= room) this.partial += s;
    else {
      if (room > 0) this.partial += s.slice(0, room);
      this.partialDropped += utf8Length(room > 0 ? s.slice(room) : s);
    }
  }

  private line(line: string, dropped: number): void {
    if (line.length === 0 && dropped === 0) {
      this.dispatch();
      return;
    }
    if (line.charCodeAt(0) === 58 /* : */) return; // comment
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    switch (field) {
      case 'data': {
        if (this.dataLines > 0) this.dataBytes += 1;
        this.dataLines++;
        this.dataBytes += utf8Length(value) + dropped;
        const room = Math.max(0, this.keep()) - this.dataKept;
        const part = (this.dataLines > 1 ? '\n' : '') + value;
        if (dropped > 0) this.dataCut = true;
        if (room <= 0) {
          if (part.length > 0) this.dataCut = true;
        } else {
          const kept = part.length > room ? part.slice(0, room) : part;
          if (kept.length < part.length) this.dataCut = true;
          this.dataParts.push(kept);
          this.dataKept += kept.length;
        }
        break;
      }
      case 'event':
        this.eventType = value;
        break;
      case 'id':
        if (value.indexOf('\u0000') < 0) this.eventId = value;
        break;
      case 'retry':
        if (/^[0-9]+$/.test(value)) this.retry = parseInt(value, 10);
        break;
      default:
        break;
    }
  }

  private dispatch(): void {
    const lines = this.dataLines;
    const event: SseEvent = { data: this.dataParts.join(''), size: this.dataBytes };
    if (this.dataCut) event.cut = true;
    if (this.eventType && this.eventType !== 'message') event.event = this.eventType;
    if (this.eventId !== undefined) event.id = this.eventId;
    if (this.retry !== undefined) event.retry = this.retry;
    this.dataParts = [];
    this.dataLines = 0;
    this.dataKept = 0;
    this.dataBytes = 0;
    this.dataCut = false;
    this.eventType = '';
    this.eventId = undefined;
    this.retry = undefined;
    // An empty data buffer dispatches nothing (like EventSource).
    if (lines > 0) this.onEvent(event);
  }
}

/** Streaming UTF-8 decoding: a character split between two chunks is decoded once both halves arrived. */
export class Utf8Stream {
  private tail: Uint8Array | undefined;

  decode(chunk: Uint8Array): string {
    let bytes = chunk;
    if (this.tail) {
      const joined = new Uint8Array(this.tail.length + chunk.length);
      joined.set(this.tail, 0);
      joined.set(chunk, this.tail.length);
      bytes = joined;
      this.tail = undefined;
    }
    const cut = incompleteTailStart(bytes);
    if (cut < bytes.length) this.tail = bytes.slice(cut);
    return cut === 0 ? '' : utf8Decode(cut === bytes.length ? bytes : bytes.subarray(0, cut));
  }
}

/** `net.sse` for one parsed event, with the payload cut at `cap` bytes. */
export function sseMessage(id: string, ts: number, event: SseEvent, cap: number): SdkNetSse {
  const msg: SdkNetSse = { type: 'net.sse', id, ts, size: event.size };
  if (event.event) msg.event = event.event.slice(0, SHORT_FIELD);
  if (event.id !== undefined) msg.eventId = event.id.slice(0, SHORT_FIELD);
  if (event.retry !== undefined) msg.retry = event.retry;
  if (cap > 0 && event.size > 0) {
    const data = truncateUtf8(event.data, cap);
    const body: WireBody = { encoding: 'utf8', data, size: event.size };
    if (event.cut || event.size > cap || data.length < event.data.length) body.truncated = true;
    msg.body = body;
  }
  return msg;
}

/**
 * Turns one event-stream response (`net.request` `id`, its `net.response` already sent without a body) into
 * `net.sse` messages, then its end: `end: true`, a cancel by the app (`net.error` cancelled) or a failure.
 * Everything goes through `emit`; nothing is sent while the desktop does not ask for streams.
 */
export class SseTap {
  private readonly parser: SseParser;
  private decoder: Utf8Stream | undefined;
  private done = false;

  constructor(
    private readonly host: Pick<NetworkHost, 'streamCapture' | 'debug'>,
    private readonly id: string,
    private readonly emit: (msg: SdkNetSse | SdkNetError) => void,
  ) {
    this.parser = new SseParser(
      (event) => {
        const cap = this.host.streamCapture();
        if (cap !== undefined) this.emit(sseMessage(this.id, Date.now(), event, cap));
      },
      () => this.host.streamCapture() ?? 0,
    );
  }

  get finished(): boolean {
    return this.done;
  }

  text(chunk: string): void {
    if (this.done) return;
    try {
      this.parser.feed(chunk);
    } catch (e) {
      this.host.debug('event stream', e);
    }
  }

  bytes(chunk: unknown): void {
    if (this.done) return;
    try {
      const bytes = typeof chunk === 'string' ? utf8Encode(chunk) : binaryBytes(chunk);
      if (!bytes) return;
      this.parser.feed((this.decoder || (this.decoder = new Utf8Stream())).decode(bytes));
    } catch (e) {
      this.host.debug('event stream', e);
    }
  }

  /** The server ended the stream. */
  end(): void {
    this.finish(() => ({ type: 'net.sse', id: this.id, ts: Date.now(), end: true }));
  }

  /** The app closed the stream (aborted the request / cancelled the reader). */
  cancel(): void {
    this.finish(() => ({ type: 'net.error', id: this.id, ts: Date.now(), error: 'Stream closed by the app', cancelled: true }));
  }

  fail(error: unknown): void {
    this.finish(() => ({ type: 'net.error', id: this.id, ts: Date.now(), error: typeof error === 'string' ? error : errorMessage(error) || 'Stream failed' }));
  }

  private finish(build: () => SdkNetSse | SdkNetError): void {
    if (this.done) return;
    this.done = true;
    try {
      if (this.host.streamCapture() !== undefined) this.emit(build());
    } catch (e) {
      this.host.debug('event stream end', e);
    }
  }
}

/* ────────────────────────────── global constructors ────────────────────────────── */

type Ctor = new (...args: any[]) => any;

/**
 * Replaces the global class `name` with a subclass built by `make`, so `instanceof`, static members and
 * prototype lookups keep working. `x instanceof <patched>` stays true for instances made with the original
 * (a reference taken before the patch), and the subclass keeps the original's `name`.
 */
export function patchGlobalClass(name: string, make: (original: Ctor, isActive: () => boolean) => Ctor): Patch | undefined {
  return patchMethod<any>(g, name, (original: Ctor, isActive) => {
    const Sub = make(original, isActive);
    try {
      Object.defineProperty(Sub, 'name', { value: (original as AnyRecord).name, configurable: true });
    } catch {
      // ignore
    }
    const hasInstance = typeof Symbol === 'function' ? Symbol.hasInstance : undefined;
    if (hasInstance) {
      const plain = (Function.prototype as AnyRecord)[hasInstance as unknown as string];
      try {
        Object.defineProperty(Sub, hasInstance, {
          configurable: true,
          writable: true,
          value(this: unknown, value: unknown): boolean {
            // Subclasses written by the app inherit this static: they keep the plain check.
            if (this !== Sub) return typeof plain === 'function' ? plain.call(this, value) : false;
            return value instanceof original;
          },
        });
      } catch {
        // ignore
      }
    }
    return Sub;
  });
}
