// The `app-data` device action of the dev mock: the same reply shape as the server (AppDataPullData, checked by
// src/features/device/appData.test.ts) and a small real .tar.gz to download.
import zlib from 'node:zlib';

const block = 512;

function header(name, size, type = '0') {
  const b = Buffer.alloc(block);
  b.write(name, 0, 100, 'utf8');
  b.write('0000644\0', 100, 'ascii');
  b.write('0000000\0', 108, 'ascii');
  b.write('0000000\0', 116, 'ascii');
  b.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  b.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'ascii');
  b.write('        ', 148, 'ascii');
  b.write(type, 156, 'ascii');
  b.write('ustar\0', 257, 'ascii');
  b.write('00', 263, 'ascii');
  let sum = 0;
  for (const x of b) sum += x;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return b;
}

/** A tiny app data folder (shared_prefs + a database stand-in) as .tar.gz. */
export function appDataArchive(appId) {
  const files = [
    [`shared_prefs/${appId}_preferences.xml`, `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n  <boolean name="onboarding_done" value="true" />\n  <string name="locale">tr-TR</string>\n</map>\n`],
    ['databases/app.db', 'SQLite format 3\0 (mock)'],
    ['files/cart.json', '{"items":[{"sku":"A-12","qty":2}]}\n'],
  ];
  const parts = [];
  for (const dir of ['shared_prefs/', 'databases/', 'files/']) parts.push(header(dir, 0, '5'));
  for (const [name, text] of files) {
    const body = Buffer.from(text);
    parts.push(header(name, body.length), body, Buffer.alloc((block - (body.length % block)) % block));
  }
  parts.push(Buffer.alloc(block * 2));
  return zlib.gzipSync(Buffer.concat(parts));
}

/** Reply data of a finished copy (AppDataPullData). */
export function appDataReply(device, appId, startedAt) {
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date(startedAt);
  const label = String(device.name ?? 'device').replace(/[^A-Za-z0-9._-]+/g, '-');
  const fileName = `app-data-${appId}-${label}`.slice(0, 49) + `-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.tar.gz`;
  const bytes = appDataArchive(appId).length;
  return {
    url: `/api/files/app-data.tar.gz?app=${encodeURIComponent(appId)}`,
    file: `/tmp/durbun/${fileName}`,
    fileName,
    appId,
    bytes: 2_412_544 + bytes,
    rawBytes: 9_830_400,
    durationSec: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
  };
}
