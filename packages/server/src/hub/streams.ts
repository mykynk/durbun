/**
 * Messages of stream entries (WebSocket messages, SSE events): per network entry, in arrival order (`seq`).
 *
 * Limits (all visible: every message removed counts into its entry's StreamInfo.dropped):
 *   - per connection at most MAX_STREAM_MESSAGES; past it the oldest go, except the first STREAM_HEAD_KEPT
 *     (handshake, auth, subscribe: what explains the rest), which stay until the budget alone forces them out;
 *   - one payload is cut at STREAM_MESSAGE_CAP on arrival (`truncated`, `size` stays the full size);
 *   - a total byte budget across connections (StreamLimits.maxBytes): the least recently active connection
 *     gives up its oldest messages first, so the socket the user is watching keeps its history longest.
 * The entry going (limits, clear) takes its messages with it (NetworkStore removes them).
 */
import { STREAM_HEAD_KEPT, type StreamMessage, type WireBody } from '@durbun/protocol';

/** Messages kept per connection (the first STREAM_HEAD_KEPT plus the newest). */
export const MAX_STREAM_MESSAGES = 2_000;
/** Payload bytes kept per message (the SDKs cut at min(maxBodyBytes, this) already; the server enforces it). */
export const STREAM_MESSAGE_CAP = 64 * 1024;
/** Per-message bookkeeping counted against the budget besides the payload. */
const MESSAGE_OVERHEAD = 96;

export interface StreamLimits {
  /** Total budget in bytes (approximated by the in-memory string length of payloads + overhead). */
  maxBytes: number;
}

interface Conn {
  /** The first messages of the connection (at most STREAM_HEAD_KEPT). */
  head: StreamMessage[];
  /** The rest, oldest first; `start` is the first live index (shift without O(n) copies). */
  tail: StreamMessage[];
  start: number;
  bytes: number;
}

/** Cuts a payload to `cap` bytes of data (utf8 by characters, base64 on a 4-char boundary). */
export function capBody(body: WireBody, cap = STREAM_MESSAGE_CAP): WireBody {
  if (body.data.length <= cap) return body;
  const keep = body.encoding === 'base64' ? cap - (cap % 4) : cap;
  return { ...body, data: body.data.slice(0, keep), truncated: true };
}

export function messageBytes(m: StreamMessage): number {
  return MESSAGE_OVERHEAD + (m.body?.data.length ?? 0) + (m.closeReason?.length ?? 0) + (m.event?.length ?? 0) + (m.eventId?.length ?? 0);
}

export class StreamStore {
  /** Insertion order = least recently active first (an active connection moves to the end). */
  private readonly conns = new Map<string, Conn>();
  private total = 0;

  constructor(
    private limits: StreamLimits,
    /** `count` messages of entry `id` were removed by the limits. */
    private readonly onDropped: (id: string, count: number) => void,
  ) {}

  get bytes(): number {
    return this.total;
  }

  setLimits(limits: StreamLimits): void {
    this.limits = limits;
    this.enforceBudget();
  }

  /** Stores one message (its `seq` already assigned) at the end of its connection. */
  add(id: string, message: StreamMessage): void {
    let c = this.conns.get(id);
    if (c) this.conns.delete(id);
    else c = { head: [], tail: [], start: 0, bytes: 0 };
    this.conns.set(id, c);
    const size = messageBytes(message);
    c.bytes += size;
    this.total += size;
    if (c.head.length < STREAM_HEAD_KEPT && c.tail.length === c.start) c.head.push(message);
    else c.tail.push(message);
    let dropped = 0;
    while (c.head.length + c.tail.length - c.start > MAX_STREAM_MESSAGES && this.shiftTail(c)) dropped++;
    if (dropped) this.reportDropped(id, dropped);
    this.enforceBudget();
  }

  /** Messages of entry `id` with seq > `after`, oldest first, at most `limit`. */
  page(id: string, after = 0, limit = 500): { messages: StreamMessage[]; more: boolean } {
    const c = this.conns.get(id);
    if (!c) return { messages: [], more: false };
    const out: StreamMessage[] = [];
    let more = false;
    const visit = (m: StreamMessage): boolean => {
      if (m.seq <= after) return true;
      if (out.length >= limit) {
        more = true;
        return false;
      }
      out.push(m);
      return true;
    };
    for (const m of c.head) if (!visit(m)) return { messages: out, more };
    for (let i = c.start; i < c.tail.length; i++) if (!visit(c.tail[i]!)) return { messages: out, more };
    return { messages: out, more };
  }

  /** Every message of entry `id` still held (export). */
  all(id: string): StreamMessage[] {
    const c = this.conns.get(id);
    return c ? [...c.head, ...c.tail.slice(c.start)] : [];
  }

  /** Number of messages held for `id`. */
  held(id: string): number {
    const c = this.conns.get(id);
    return c ? c.head.length + c.tail.length - c.start : 0;
  }

  has(id: string): boolean {
    return this.conns.has(id);
  }

  /** The entry is gone: its messages go too (not counted as dropped: the entry itself went). */
  forget(id: string): void {
    const c = this.conns.get(id);
    if (!c) return;
    this.total -= c.bytes;
    this.conns.delete(id);
  }

  clear(): void {
    this.conns.clear();
    this.total = 0;
  }

  /** Text search over utf8 payloads (and close reasons / event names) of entry `id`. */
  matches(id: string, has: (text: string | undefined) => boolean): boolean {
    const c = this.conns.get(id);
    if (!c) return false;
    const test = (m: StreamMessage) => (m.body?.encoding === 'utf8' && has(m.body.data)) || has(m.closeReason) || has(m.event);
    if (c.head.some(test)) return true;
    for (let i = c.start; i < c.tail.length; i++) if (test(c.tail[i]!)) return true;
    return false;
  }

  private shiftTail(c: Conn): boolean {
    if (c.start >= c.tail.length) return false;
    const gone = c.tail[c.start]!;
    c.tail[c.start] = undefined as unknown as StreamMessage;
    c.start++;
    if (c.start > 1024 && c.start * 2 > c.tail.length) {
      c.tail = c.tail.slice(c.start);
      c.start = 0;
    }
    const size = messageBytes(gone);
    c.bytes -= size;
    this.total -= size;
    return true;
  }

  private shiftHead(c: Conn): boolean {
    const gone = c.head.shift();
    if (!gone) return false;
    const size = messageBytes(gone);
    c.bytes -= size;
    this.total -= size;
    return true;
  }

  private enforceBudget(): void {
    const max = Math.max(0, this.limits.maxBytes);
    if (this.total <= max) return;
    // Least recently active connections first: their later messages before anyone's first STREAM_HEAD_KEPT.
    for (const shift of [this.shiftTail, this.shiftHead]) {
      for (const [id, c] of this.conns) {
        let dropped = 0;
        while (this.total > max && shift.call(this, c)) dropped++;
        if (dropped) this.reportDropped(id, dropped);
        if (this.total <= max) return;
      }
    }
  }

  private reportDropped(id: string, count: number): void {
    try {
      this.onDropped(id, count);
    } catch {
      /* counting must never break the store */
    }
  }
}
