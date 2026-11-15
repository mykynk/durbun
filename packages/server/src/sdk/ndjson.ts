/**
 * NDJSON framing. Lines are split on the byte 0x0A and decoded only once complete, so chunk boundaries
 * that cut a multi-byte UTF-8 sequence are harmless (0x0A never occurs inside a UTF-8 sequence).
 */
import { MAX_FRAME_BYTES } from '@durbun/protocol';

export interface NdjsonDecoderOptions {
  /** Called for every complete, non-blank line (without the trailing CR/LF). */
  onLine(line: string): void;
  /**
   * Called when a line exceeded `maxLineBytes`; the line is dropped and decoding resumes after it. `head` is
   * its first `headBytes` bytes (to tell what was dropped).
   */
  onOversize?(bytes: number, head: Buffer): void;
  maxLineBytes?: number;
  /** Bytes of an oversized line kept for onOversize (default 8 KiB). */
  headBytes?: number;
}

export class NdjsonDecoder {
  private chunks: Buffer[] = [];
  private pendingBytes = 0;
  /** Inside an oversized line: drop bytes until the next newline. */
  private discarding = false;
  private discardedBytes = 0;
  private discardHead: Buffer = Buffer.alloc(0);
  private readonly headBytes: number;
  /** Longest line kept; may change between chunks (the SDK layer raises it once the hello is in). */
  maxLineBytes: number;

  constructor(private readonly opts: NdjsonDecoderOptions) {
    this.maxLineBytes = opts.maxLineBytes ?? MAX_FRAME_BYTES;
    this.headBytes = Math.max(0, opts.headBytes ?? 8 * 1024);
  }

  /** First headBytes of the held chunks followed by `more` (copied: chunks may be reused by the caller). */
  private headOf(more?: Buffer): Buffer {
    const parts: Buffer[] = [];
    let size = 0;
    for (const c of more ? [...this.chunks, more] : this.chunks) {
      if (size >= this.headBytes) break;
      const take = c.subarray(0, this.headBytes - size);
      parts.push(take);
      size += take.length;
    }
    return Buffer.from(Buffer.concat(parts, size));
  }

  /** Bytes held while waiting for the end of the current line. */
  get buffered(): number {
    return this.pendingBytes;
  }

  /** Inside a line longer than maxLineBytes (dropped until its newline). */
  get overflowing(): boolean {
    return this.discarding;
  }

  push(chunk: Buffer | Uint8Array | string): void {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < buf.length) {
      const nl = buf.indexOf(0x0a, start);
      if (nl === -1) {
        this.hold(buf.subarray(start));
        return;
      }
      const piece = buf.subarray(start, nl);
      start = nl + 1;
      if (this.discarding) {
        this.discarding = false;
        const head = this.discardHead;
        this.discardHead = Buffer.alloc(0);
        this.opts.onOversize?.(this.discardedBytes + piece.length, head);
        this.discardedBytes = 0;
        continue;
      }
      let line: Buffer;
      if (this.chunks.length > 0) {
        const total = this.pendingBytes + piece.length;
        if (total > this.maxLineBytes) {
          const head = this.headOf(piece);
          this.chunks = [];
          this.pendingBytes = 0;
          this.opts.onOversize?.(total, head);
          continue;
        }
        this.chunks.push(piece);
        line = Buffer.concat(this.chunks, total);
        this.chunks = [];
        this.pendingBytes = 0;
      } else {
        if (piece.length > this.maxLineBytes) {
          this.opts.onOversize?.(piece.length, Buffer.from(piece.subarray(0, this.headBytes)));
          continue;
        }
        line = piece;
      }
      this.emit(line);
    }
  }

  /** Delivers a final unterminated line (stream ended without a trailing newline). */
  end(): void {
    if (this.discarding || this.chunks.length === 0) {
      this.reset();
      return;
    }
    const line = Buffer.concat(this.chunks, this.pendingBytes);
    this.reset();
    this.emit(line);
  }

  reset(): void {
    this.chunks = [];
    this.pendingBytes = 0;
    this.discarding = false;
    this.discardedBytes = 0;
    this.discardHead = Buffer.alloc(0);
  }

  private hold(rest: Buffer): void {
    if (rest.length === 0) return;
    if (this.discarding) {
      this.discardedBytes += rest.length;
      return;
    }
    if (this.pendingBytes + rest.length > this.maxLineBytes) {
      this.discardHead = this.headOf(rest);
      this.discarding = true;
      this.discardedBytes = this.pendingBytes + rest.length;
      this.chunks = [];
      this.pendingBytes = 0;
      return;
    }
    // Copy: some Duplex implementations reuse their chunk buffers.
    this.chunks.push(Buffer.from(rest));
    this.pendingBytes += rest.length;
  }

  private emit(raw: Buffer): void {
    let end = raw.length;
    if (end > 0 && raw[end - 1] === 0x0d) end--;
    let start = 0;
    if (end - start >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) start = 3; // UTF-8 BOM
    if (end <= start) return;
    const line = raw.toString('utf8', start, end);
    if (line.trim().length === 0) return;
    this.opts.onLine(line);
  }
}

/** One NDJSON line (JSON.stringify escapes newlines inside strings, so the frame is always one line). */
export function encodeNdjson(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
