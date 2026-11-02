/**
 * Streaming JSON serializer for large documents (session exports, HAR files). A 200 000-line export with
 * 256 MB of bodies would exceed V8's maximum string length if built with one JSON.stringify call, so the
 * outer structure is written piece by piece and only leaf values (one log line, one request) are
 * stringified at a time. Output is byte-identical to JSON.stringify(value) for plain data.
 */
import type { Writable } from 'node:stream';
import { writeChunk } from './util';

const FLUSH_AT = 64 * 1024;

class BufferedWriter {
  private parts: string[] = [];
  private size = 0;
  constructor(private readonly out: Writable) {}

  async write(s: string): Promise<void> {
    this.parts.push(s);
    this.size += s.length;
    if (this.size >= FLUSH_AT) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.size === 0) return;
    const chunk = this.parts.join('');
    this.parts = [];
    this.size = 0;
    await writeChunk(this.out, chunk);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

async function writeValue(w: BufferedWriter, value: unknown, depth: number): Promise<void> {
  if (depth > 0 && Array.isArray(value)) {
    await w.write('[');
    for (let i = 0; i < value.length; i++) {
      if (i > 0) await w.write(',');
      const el = value[i];
      // JSON.stringify writes null for undefined/function array slots.
      if (el === undefined || typeof el === 'function' || typeof el === 'symbol') await w.write('null');
      else await writeValue(w, el, depth - 1);
    }
    await w.write(']');
    return;
  }
  if (depth > 0 && isPlainObject(value)) {
    await w.write('{');
    let first = true;
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      await w.write((first ? '' : ',') + JSON.stringify(key) + ':');
      first = false;
      await writeValue(w, v, depth - 1);
    }
    await w.write('}');
    return;
  }
  const json = JSON.stringify(value);
  await w.write(json === undefined ? 'null' : json);
}

/**
 * Write `value` as JSON to `out` (without ending it). Containers up to `depth` levels deep are streamed;
 * deeper values are stringified whole. Rejects when the client disconnects.
 */
export async function streamJson(out: Writable, value: unknown, depth: number): Promise<void> {
  const w = new BufferedWriter(out);
  await writeValue(w, value, depth);
  await w.flush();
}
