/**
 * Menu-bar (tray) icon: the binoculars glyph of packages/ui/public/icon.svg drawn as a macOS template
 * image (black + alpha; macOS tints it for light/dark menu bars). Rasterized with signed distances so
 * no image file or library is needed.
 */

type Sdf = (x: number, y: number) => number;

const circle =
  (cx: number, cy: number, r: number): Sdf =>
  (x, y) =>
    Math.hypot(x - cx, y - cy) - r;

/** Rounded rectangle; `rTop`/`rBottom` radii (the SVG body paths have rounded tops only). */
const roundRect =
  (x0: number, y0: number, w: number, h: number, rTop: number, rBottom = rTop): Sdf =>
  (x, y) => {
    const cx = x0 + w / 2;
    const cy = y0 + h / 2;
    const r = y < cy ? rTop : rBottom;
    const qx = Math.abs(x - cx) - w / 2 + r;
    const qy = Math.abs(y - cy) - h / 2 + r;
    return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
  };

// Shapes in the SVG's 32×32 coordinate space.
const solids: Sdf[] = [
  roundRect(8.6, 6.2, 4.4, 4.6, 1.2), // eyepieces
  roundRect(19, 6.2, 4.4, 4.6, 1.2),
  roundRect(7.4, 10.2, 7.2, 7.0, 2.4, 0), // bodies
  roundRect(17.4, 10.2, 7.2, 7.0, 2.4, 0),
  roundRect(13.6, 12.6, 4.8, 3.6, 1), // bridge
  circle(11, 20.4, 5.4), // lens barrels
  circle(21, 20.4, 5.4),
];
const holes: Sdf[] = [circle(11, 20.4, 2.9), circle(21, 20.4, 2.9)];

const GLYPH = { x0: 5.6, y0: 6.2, x1: 26.4, y1: 25.8 };

export function glyphDistance(x: number, y: number): number {
  let d = Infinity;
  for (const s of solids) d = Math.min(d, s(x, y));
  for (const h of holes) d = Math.max(d, -h(x, y));
  return d;
}

/**
 * Raw 8-bit BGRA (premultiplied; black, so only alpha matters) bitmap of `sizePx`², glyph fitted into
 * `sizePx - 2·paddingPx`.
 */
export function renderTrayBitmap(sizePx = 36, paddingPx = 3): Buffer {
  const buf = Buffer.alloc(sizePx * sizePx * 4);
  const gw = GLYPH.x1 - GLYPH.x0;
  const gh = GLYPH.y1 - GLYPH.y0;
  const scale = (sizePx - 2 * paddingPx) / Math.max(gw, gh); // px per SVG unit
  const offX = (sizePx - gw * scale) / 2;
  const offY = (sizePx - gh * scale) / 2;
  const SS = 4; // 4×4 supersampling
  for (let py = 0; py < sizePx; py++) {
    for (let px = 0; px < sizePx; px++) {
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = GLYPH.x0 + (px + (sx + 0.5) / SS - offX) / scale;
          const uy = GLYPH.y0 + (py + (sy + 0.5) / SS - offY) / scale;
          if (glyphDistance(ux, uy) <= 0) cover++;
        }
      }
      const a = Math.round((cover / (SS * SS)) * 255);
      buf[(py * sizePx + px) * 4 + 3] = a;
    }
  }
  return buf;
}
