/**
 * The package name of an .apk, read from the file itself (no aapt / apkanalyzer on the Mac needed): the zip's
 * central directory gives AndroidManifest.xml, which is Android's binary XML (a string pool, then element
 * chunks); `<manifest package="…">` is the first element. Layouts follow the zip specification (APPNOTE) and
 * the binary XML chunks of the Android framework (ResourceTypes.h: ResChunk_header, ResStringPool_header,
 * ResXMLTree_attrExt, Res_value). Anything unexpected → undefined (the caller says it could not be read).
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
/** A manifest is a few KB; anything this large is not one. */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
/** The directory of even a very large app is a few MB; a file that claims more is not read into memory. */
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;

/** Package name of an .apk file, or undefined when it cannot be read. */
export async function apkPackageId(file: string): Promise<string | undefined> {
  try {
    const manifest = await readZipEntry(file, 'AndroidManifest.xml');
    return manifest ? manifestPackage(manifest) : undefined;
  } catch {
    return undefined;
  }
}

/** One entry of a zip file (stored or deflated), or undefined when it is not there or the zip is unusual. */
export async function readZipEntry(file: string, name: string): Promise<Buffer | undefined> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return undefined;
    const count = tail.readUInt16LE(eocd + 10);
    const cenSize = tail.readUInt32LE(eocd + 12);
    const cenOffset = tail.readUInt32LE(eocd + 16);
    if (cenOffset === 0xffffffff || cenSize === 0xffffffff || cenOffset + cenSize > size) return undefined; // zip64
    if (cenSize > MAX_DIRECTORY_BYTES) return undefined;
    const cen = Buffer.alloc(cenSize);
    await fh.read(cen, 0, cenSize, cenOffset);
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cen.length; n += 1) {
      if (cen.readUInt32LE(p) !== CEN_SIG) return undefined;
      const method = cen.readUInt16LE(p + 10);
      const compSize = cen.readUInt32LE(p + 20);
      const rawSize = cen.readUInt32LE(p + 24);
      const nameLen = cen.readUInt16LE(p + 28);
      const extraLen = cen.readUInt16LE(p + 30);
      const commentLen = cen.readUInt16LE(p + 32);
      const localOffset = cen.readUInt32LE(p + 42);
      const entryName = cen.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (entryName !== name) continue;
      if (rawSize > MAX_MANIFEST_BYTES || compSize > MAX_MANIFEST_BYTES) return undefined;
      const local = Buffer.alloc(30);
      await fh.read(local, 0, 30, localOffset);
      if (local.readUInt32LE(0) !== LOC_SIG) return undefined;
      const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const data = Buffer.alloc(compSize);
      await fh.read(data, 0, compSize, dataStart);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_MANIFEST_BYTES });
      return undefined;
    }
    return undefined;
  } finally {
    await fh.close();
  }
}

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const UTF8_FLAG = 0x100;
const TYPE_STRING = 0x03;

/** `package` of the root `<manifest>` element of a binary AndroidManifest.xml. */
export function manifestPackage(xml: Buffer): string | undefined {
  if (xml.length < 8 || xml.readUInt16LE(0) !== RES_XML_TYPE) return undefined;
  let strings: string[] | undefined;
  let p = xml.readUInt16LE(2);
  while (p + 8 <= xml.length) {
    const type = xml.readUInt16LE(p);
    const headerSize = xml.readUInt16LE(p + 2);
    const size = xml.readUInt32LE(p + 4);
    if (size < 8 || p + size > xml.length) return undefined;
    if (type === RES_STRING_POOL_TYPE) {
      strings = readStringPool(xml, p);
    } else if (type === RES_XML_START_ELEMENT_TYPE) {
      if (!strings) return undefined;
      const ext = p + headerSize;
      const name = strings[xml.readUInt32LE(ext + 4)];
      if (name !== 'manifest') return undefined; // the root element comes first
      const attrStart = xml.readUInt16LE(ext + 8);
      const attrSize = xml.readUInt16LE(ext + 10);
      const attrCount = xml.readUInt16LE(ext + 12);
      for (let i = 0; i < attrCount; i += 1) {
        const a = ext + attrStart + i * attrSize;
        if (a + 20 > p + size) return undefined;
        if (strings[xml.readUInt32LE(a + 4)] !== 'package') continue;
        const raw = xml.readUInt32LE(a + 8);
        const dataType = xml.readUInt8(a + 15);
        const index = raw !== 0xffffffff ? raw : dataType === TYPE_STRING ? xml.readUInt32LE(a + 16) : -1;
        const value = strings[index];
        return value && /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(value) ? value : undefined;
      }
      return undefined;
    }
    p += size;
  }
  return undefined;
}

function readStringPool(buf: Buffer, start: number): string[] {
  const headerSize = buf.readUInt16LE(start + 2);
  const count = buf.readUInt32LE(start + 8);
  const flags = buf.readUInt32LE(start + 16);
  const stringsStart = buf.readUInt32LE(start + 20);
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const out: string[] = [];
  for (let i = 0; i < Math.min(count, 100_000); i += 1) {
    const offset = buf.readUInt32LE(start + headerSize + i * 4);
    let s = start + stringsStart + offset;
    if (utf8) {
      // UTF-16 length, then UTF-8 byte length (each one or two bytes), then the bytes.
      s += buf[s]! & 0x80 ? 2 : 1;
      let len = buf[s]!;
      if (len & 0x80) {
        len = ((len & 0x7f) << 8) | buf[s + 1]!;
        s += 2;
      } else s += 1;
      out.push(buf.toString('utf8', s, s + len));
    } else {
      let len = buf.readUInt16LE(s);
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | buf.readUInt16LE(s + 2);
        s += 4;
      } else s += 2;
      out.push(buf.toString('utf16le', s, s + len * 2));
    }
  }
  return out;
}
