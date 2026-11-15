/**
 * A small ZIP writer (PKWARE APPNOTE 6.3, no ZIP64): enough for a bug report of a few files that issue trackers
 * accept as one attachment. Text is deflated (node:zlib), already compressed data (PNG, JPEG) is stored.
 */
import { deflateRawSync } from 'node:zlib';

export interface ZipFile {
  /** Path inside the archive ("/" separated, UTF-8). */
  name: string;
  data: Buffer;
  /** Store without compressing (already compressed formats). */
  store?: boolean;
  /** Modification time (epoch ms); default now. */
  mtime?: number;
}

/** ZIP without ZIP64 ends at 4 GiB and 65,535 entries; a bug report stays far below. */
const MAX_TOTAL = 0xffff_fffe;

let table: Uint32Array | undefined;

/** CRC-32 (IEEE 802.3), as ZIP stores it. */
export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time (local time, 2-second resolution, 1980–2107). */
function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Builds the archive in memory. Names must be unique; a leading "/" or ".." segment is refused. */
export function createZip(files: readonly ZipFile[], now = Date.now()): Buffer {
  const seen = new Set<string>();
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    if (!f.name || f.name.startsWith('/') || f.name.split('/').includes('..') || seen.has(f.name)) throw new Error(`Bad zip entry name: ${f.name}`);
    seen.add(f.name);
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const deflated = f.store ? undefined : deflateRawSync(f.data);
    // Deflate can grow incompressible data: store it then.
    const method = deflated && deflated.length < f.data.length ? 8 : 0;
    const body = method === 8 ? deflated! : f.data;
    const { time, date } = dosTime(f.mtime ?? now);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x0314, 4); // made by: Unix, 2.0
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(f.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
    entry.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
    if (offset > MAX_TOTAL) throw new Error('The archive is too large');
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** Reads an archive this module wrote (tests, and a check before a file leaves the Mac). */
export function readZip(zip: Buffer, inflate: (b: Buffer) => Buffer): { name: string; data: Buffer }[] {
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('Not a zip file');
  const count = zip.readUInt16LE(endAt + 10);
  let p = zip.readUInt32LE(endAt + 16);
  const out: { name: string; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad central directory');
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const at = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    const dataAt = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
    const raw = zip.subarray(dataAt, dataAt + size);
    const data = method === 8 ? inflate(raw) : Buffer.from(raw);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch: ${name}`);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
