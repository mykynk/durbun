/**
 * Tiny dependency-free PNG encoder + raster canvas, used for demo image responses (pet thumbnails) and
 * demo screenshots. Produces real, valid PNG bytes (RGBA, 8-bit, zlib via node:zlib).
 */
import { deflateSync } from 'node:zlib';

export type Rgba = readonly [number, number, number, number];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encodes straight RGBA pixels (row-major, 4 bytes per pixel) as a PNG file. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function hexColor(hex: string, alpha = 255): Rgba {
  const h = hex.replace('#', '');
  return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16), alpha];
}

export function shade(c: Rgba, factor: number): Rgba {
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * factor)));
  return [f(c[0]), f(c[1]), f(c[2]), c[3]];
}

export class Canvas {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    background: Rgba,
  ) {
    this.data = new Uint8Array(width * height * 4);
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = background[0];
      this.data[i + 1] = background[1];
      this.data[i + 2] = background[2];
      this.data[i + 3] = background[3];
    }
  }

  /** Alpha-blends one pixel; `coverage` (0..1) scales the colour alpha (anti-aliasing). */
  blend(x: number, y: number, c: Rgba, coverage = 1): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const a = (c[3] / 255) * coverage;
    if (a <= 0) return;
    const i = (y * this.width + x) * 4;
    const d = this.data;
    d[i] = Math.round(c[0] * a + d[i]! * (1 - a));
    d[i + 1] = Math.round(c[1] * a + d[i + 1]! * (1 - a));
    d[i + 2] = Math.round(c[2] * a + d[i + 2]! * (1 - a));
    d[i + 3] = Math.min(255, Math.round(255 * a + d[i + 3]! * (1 - a)));
  }

  fillRect(x: number, y: number, w: number, h: number, c: Rgba): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w));
    const y1 = Math.min(this.height, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.blend(xx, yy, c);
  }

  fillEllipse(cx: number, cy: number, rx: number, ry: number, c: Rgba): void {
    const x0 = Math.floor(cx - rx - 1);
    const x1 = Math.ceil(cx + rx + 1);
    const y0 = Math.floor(cy - ry - 1);
    const y1 = Math.ceil(cy + ry + 1);
    const r = Math.min(rx, ry);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        const d = Math.sqrt(dx * dx + dy * dy);
        const coverage = Math.max(0, Math.min(1, (1 - d) * r + 0.5));
        if (coverage > 0) this.blend(x, y, c, coverage);
      }
    }
  }

  fillCircle(cx: number, cy: number, r: number, c: Rgba): void {
    this.fillEllipse(cx, cy, r, r, c);
  }

  fillRoundRect(x: number, y: number, w: number, h: number, radius: number, c: Rgba): void {
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
    if (r < 1) {
      this.fillRect(x, y, w, h, c);
      return;
    }
    this.fillRect(x + r, y, w - 2 * r, h, c);
    this.fillRect(x, y + r, r, h - 2 * r, c);
    this.fillRect(x + w - r, y + r, r, h - 2 * r, c);
    // corners: quarter circles, anti-aliased
    const corners: [number, number][] = [
      [x + r, y + r],
      [x + w - r, y + r],
      [x + r, y + h - r],
      [x + w - r, y + h - r],
    ];
    for (const [ccx, ccy] of corners) {
      const left = ccx === x + r;
      const top = ccy === y + r;
      const qx0 = Math.floor(left ? x : ccx);
      const qy0 = Math.floor(top ? y : ccy);
      for (let yy = qy0; yy < qy0 + Math.ceil(r); yy++) {
        for (let xx = qx0; xx < qx0 + Math.ceil(r); xx++) {
          const dx = xx + 0.5 - ccx;
          const dy = yy + 0.5 - ccy;
          const coverage = Math.max(0, Math.min(1, r - Math.sqrt(dx * dx + dy * dy) + 0.5));
          if (coverage > 0) this.blend(xx, yy, c, coverage);
        }
      }
    }
  }

  verticalGradient(y0: number, y1: number, top: Rgba, bottom: Rgba): void {
    for (let y = Math.max(0, y0); y < Math.min(this.height, y1); y++) {
      const t = (y - y0) / Math.max(1, y1 - y0 - 1);
      const c: Rgba = [
        Math.round(top[0] + (bottom[0] - top[0]) * t),
        Math.round(top[1] + (bottom[1] - top[1]) * t),
        Math.round(top[2] + (bottom[2] - top[2]) * t),
        Math.round(top[3] + (bottom[3] - top[3]) * t),
      ];
      this.fillRect(0, y, this.width, 1, c);
    }
  }

  /** A paw print centred at (cx, cy) with overall size `s`. */
  paw(cx: number, cy: number, s: number, c: Rgba): void {
    this.fillEllipse(cx, cy + s * 0.12, s * 0.2, s * 0.17, c);
    this.fillEllipse(cx - s * 0.22, cy - s * 0.1, s * 0.075, s * 0.09, c);
    this.fillEllipse(cx - s * 0.08, cy - s * 0.22, s * 0.08, s * 0.1, c);
    this.fillEllipse(cx + s * 0.08, cy - s * 0.22, s * 0.08, s * 0.1, c);
    this.fillEllipse(cx + s * 0.22, cy - s * 0.1, s * 0.075, s * 0.09, c);
  }

  toPng(): Buffer {
    return encodePng(this.width, this.height, this.data);
  }
}

const PASTELS = ['#FFD6A5', '#CAFFBF', '#9BF6FF', '#BDB2FF', '#FFC6FF', '#FDFFB6', '#A0C4FF', '#FFADAD'];

/** Square pet thumbnail: pastel background + paw print (a few hundred bytes). */
export function petThumbnailPng(seed: number, size = 96): Buffer {
  const base = hexColor(PASTELS[Math.abs(seed) % PASTELS.length]!);
  const canvas = new Canvas(size, size, base);
  canvas.fillCircle(size * 0.78, size * 0.2, size * 0.28, shade(base, 1.06));
  canvas.paw(size / 2, size * 0.55, size * 0.9, shade(base, 0.62));
  return canvas.toPng();
}

export interface ScreenshotOptions {
  width: number;
  height: number;
  platform: 'android' | 'ios';
  dark: boolean;
  seed: number;
  accent?: string;
}

/** A believable app screenshot: status bar, app bar, grid of pet cards, bottom navigation. */
export function screenshotPng(opts: ScreenshotOptions): Buffer {
  const { width: w, height: h, dark } = opts;
  const bg = dark ? hexColor('#0F1117') : hexColor('#F5F6F9');
  const surface = dark ? hexColor('#1A1D27') : hexColor('#FFFFFF');
  const text = dark ? hexColor('#E6E9F0') : hexColor('#161A23');
  const muted = dark ? hexColor('#6B7488') : hexColor('#B4BACB');
  const accent = hexColor(opts.accent ?? '#7C6CF2');
  const c = new Canvas(w, h, bg);
  const u = w / 400; // layout unit

  const statusH = Math.round((opts.platform === 'ios' ? 54 : 32) * u);
  const appBarH = Math.round(64 * u);
  c.fillRect(0, 0, w, statusH + appBarH, accent);
  // status bar: time + indicators
  c.fillRoundRect(18 * u, statusH * 0.38, 46 * u, 12 * u, 6 * u, hexColor('#FFFFFF', 235));
  c.fillRoundRect(w - 70 * u, statusH * 0.4, 18 * u, 10 * u, 3 * u, hexColor('#FFFFFF', 220));
  c.fillRoundRect(w - 46 * u, statusH * 0.4, 28 * u, 10 * u, 3 * u, hexColor('#FFFFFF', 220));
  if (opts.platform === 'ios') c.fillRoundRect(w / 2 - 62 * u, 11 * u, 124 * u, 34 * u, 17 * u, hexColor('#000000'));
  // app bar title + avatar
  c.fillRoundRect(20 * u, statusH + 22 * u, 120 * u, 18 * u, 9 * u, hexColor('#FFFFFF', 240));
  c.fillCircle(w - 36 * u, statusH + 31 * u, 15 * u, hexColor('#FFFFFF', 210));
  c.paw(w - 36 * u, statusH + 33 * u, 22 * u, accent);

  // search field
  const top = statusH + appBarH + 14 * u;
  c.fillRoundRect(16 * u, top, w - 32 * u, 40 * u, 20 * u, surface);
  c.fillRoundRect(34 * u, top + 15 * u, 150 * u, 10 * u, 5 * u, muted);

  // grid of pet cards
  const gridTop = top + 56 * u;
  const gap = 12 * u;
  const cardW = (w - 16 * u * 2 - gap) / 2;
  const cardH = cardW * 1.32;
  const navH = Math.round((opts.platform === 'ios' ? 84 : 72) * u);
  for (let i = 0; i < 8; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 16 * u + col * (cardW + gap);
    const y = gridTop + row * (cardH + gap);
    if (y > h - navH) break;
    c.fillRoundRect(x, y, cardW, cardH, 14 * u, surface);
    const photo = hexColor(PASTELS[(opts.seed + i) % PASTELS.length]!);
    c.fillRoundRect(x + 8 * u, y + 8 * u, cardW - 16 * u, cardW * 0.82, 10 * u, photo);
    c.paw(x + cardW / 2, y + 8 * u + cardW * 0.43, cardW * 0.55, shade(photo, 0.65));
    c.fillRoundRect(x + 12 * u, y + cardW * 0.82 + 20 * u, cardW * 0.55, 11 * u, 5 * u, text);
    c.fillRoundRect(x + 12 * u, y + cardW * 0.82 + 38 * u, cardW * 0.38, 9 * u, 4 * u, muted);
    c.fillCircle(x + cardW - 22 * u, y + cardW * 0.82 + 30 * u, 10 * u, i % 3 === 0 ? hexColor('#FF6369') : muted);
  }

  // bottom navigation
  c.fillRect(0, h - navH, w, navH, surface);
  c.fillRect(0, h - navH, w, Math.max(1, u), dark ? hexColor('#232937') : hexColor('#E3E6EE'));
  for (let i = 0; i < 4; i++) {
    const cx = (w / 4) * (i + 0.5);
    const cy = h - navH + 26 * u;
    if (i === 0) c.fillRoundRect(cx - 30 * u, cy - 14 * u, 60 * u, 28 * u, 14 * u, hexColor('#7C6CF2', 60));
    c.fillCircle(cx, cy, 9 * u, i === 0 ? accent : muted);
    c.fillRoundRect(cx - 16 * u, cy + 18 * u, 32 * u, 6 * u, 3 * u, i === 0 ? accent : muted);
  }
  if (opts.platform === 'ios') c.fillRoundRect(w / 2 - 68 * u, h - 12 * u, 136 * u, 5 * u, 3 * u, text);
  return c.toPng();
}
