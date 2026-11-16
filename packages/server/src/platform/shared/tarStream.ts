/**
 * A small streaming tar writer (POSIX ustar, PAX records for long names) for copying a folder on this Mac, e.g. a
 * simulator app's data container. Files are read in chunks as the archive is consumed: nothing is held whole in
 * memory. Symlinks are stored as links and never followed, so the walk stays inside the folder it was given.
 */
import fs from 'node:fs';
import path from 'node:path';

const BLOCK = 512;
const ZERO = Buffer.alloc(BLOCK);

export interface TarHeader {
  /** Path inside the archive, '/'-separated, no leading '/'. A directory may end with '/'. */
  name: string;
  type: 'file' | 'dir' | 'symlink';
  size?: number;
  mode?: number;
  /** Seconds since epoch. */
  mtime?: number;
  linkname?: string;
}

function octal(value: number, width: number): string {
  // width includes the trailing NUL.
  return Math.max(0, Math.floor(value)).toString(8).padStart(width - 1, '0') + '\0';
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

function rawHeader(h: TarHeader, typeflag: string, name: string, linkname: string, size: number): Buffer {
  const b = Buffer.alloc(BLOCK);
  b.write(name, 0, 100, 'utf8');
  b.write(octal(h.mode ?? (h.type === 'dir' ? 0o755 : 0o644), 8), 100, 'ascii');
  b.write(octal(0, 8), 108, 'ascii');
  b.write(octal(0, 8), 116, 'ascii');
  b.write(octal(size, 12), 124, 'ascii');
  b.write(octal(h.mtime ?? 0, 12), 136, 'ascii');
  b.write('        ', 148, 'ascii');
  b.write(typeflag, 156, 'ascii');
  b.write(linkname, 157, 100, 'utf8');
  b.write('ustar\0', 257, 'ascii');
  b.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(octal(sum, 7) + ' ', 148, 'ascii');
  return b;
}

/** The header block(s) of one entry: a PAX record block first when a name or link does not fit ustar's 100 bytes. */
export function tarHeader(h: TarHeader): Buffer {
  const name = h.type === 'dir' && !h.name.endsWith('/') ? `${h.name}/` : h.name;
  const link = h.linkname ?? '';
  const size = h.type === 'file' ? (h.size ?? 0) : 0;
  const typeflag = h.type === 'dir' ? '5' : h.type === 'symlink' ? '2' : '0';
  const longName = Buffer.byteLength(name) > 100;
  const longLink = Buffer.byteLength(link) > 100;
  const parts: Buffer[] = [];
  if (longName || longLink) {
    const pax = Buffer.from((longName ? paxRecord('path', name) : '') + (longLink ? paxRecord('linkpath', link) : ''));
    parts.push(rawHeader({ name: 'PaxHeader', type: 'file', mtime: h.mtime }, 'x', 'PaxHeader', '', pax.length));
    parts.push(pax, ZERO.subarray(0, padding(pax.length)));
  }
  parts.push(rawHeader(h, typeflag, cut(name, 100), cut(link, 100), size));
  return Buffer.concat(parts);
}

/** Bytes up to `max` without splitting a UTF-8 character. */
function cut(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out + ch) > max) break;
    out += ch;
  }
  return out;
}

export function padding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

/** The two zero blocks that end an archive. */
export function tarEnd(): Buffer {
  return Buffer.alloc(BLOCK * 2);
}

/** True when a 512-byte block looks like a tar header (ustar or GNU magic at offset 257). */
export function looksLikeTar(head: Buffer): boolean {
  return head.length >= 263 && head.toString('latin1', 257, 262) === 'ustar';
}

export interface TarDirOptions {
  /** Skip this entry (and, for a folder, all below it). `rel` is '/'-separated. */
  exclude?: (rel: string, isDir: boolean) => boolean;
  /** Called once per regular file stored (counting). */
  onFile?: (rel: string, size: number) => void;
}

/**
 * Stream a folder as tar blocks. Entry names are relative to `root`. Sockets, FIFOs and devices are skipped;
 * a file that changes size while it is read is cut or zero-padded to the size in its header.
 */
export async function* tarDirectory(root: string, opts: TarDirOptions = {}): AsyncGenerator<Buffer> {
  async function* walk(dir: string, rel: string): AsyncGenerator<Buffer> {
    let names: string[];
    try {
      names = (await fs.promises.readdir(dir)).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const abs = path.join(dir, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = await fs.promises.lstat(abs).catch(() => undefined);
      if (!st) continue;
      const mtime = Math.floor(st.mtimeMs / 1000);
      const mode = st.mode & 0o7777;
      if (st.isDirectory()) {
        if (opts.exclude?.(r, true)) continue;
        yield tarHeader({ name: r, type: 'dir', mode, mtime });
        yield* walk(abs, r);
      } else if (st.isSymbolicLink()) {
        if (opts.exclude?.(r, false)) continue;
        const target = await fs.promises.readlink(abs).catch(() => undefined);
        if (target !== undefined) yield tarHeader({ name: r, type: 'symlink', mode, mtime, linkname: target });
      } else if (st.isFile()) {
        if (opts.exclude?.(r, false)) continue;
        yield* fileEntry(abs, r, st.size, mode, mtime);
        opts.onFile?.(r, st.size);
      }
    }
  }
  yield* walk(root, '');
  yield tarEnd();
}

async function* fileEntry(abs: string, rel: string, size: number, mode: number, mtime: number): AsyncGenerator<Buffer> {
  yield tarHeader({ name: rel, type: 'file', size, mode, mtime });
  let left = size;
  if (left > 0) {
    const stream = fs.createReadStream(abs, { highWaterMark: 256 * 1024 });
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        if (left <= 0) break;
        const part = chunk.length > left ? chunk.subarray(0, left) : chunk;
        left -= part.length;
        yield part;
      }
    } catch {
      // Unreadable or vanished mid-read: the rest is zero-filled so the archive stays valid.
    } finally {
      stream.destroy();
    }
  }
  while (left > 0) {
    const n = Math.min(left, 64 * 1024);
    yield Buffer.alloc(n);
    left -= n;
  }
  const pad = padding(size);
  if (pad) yield ZERO.subarray(0, pad);
}
