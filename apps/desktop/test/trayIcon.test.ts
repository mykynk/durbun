import { describe, expect, it } from 'vitest';
import { glyphDistance, renderTrayBitmap } from '../src/trayIcon';

describe('tray icon', () => {
  it('renders a 36×36 template bitmap (black, alpha only)', () => {
    const buf = renderTrayBitmap(36, 3);
    expect(buf.length).toBe(36 * 36 * 4);
    let opaque = 0;
    let transparent = 0;
    for (let i = 0; i < buf.length; i += 4) {
      expect(buf[i]! + buf[i + 1]! + buf[i + 2]!).toBe(0);
      if (buf[i + 3] === 255) opaque++;
      if (buf[i + 3] === 0) transparent++;
    }
    expect(opaque).toBeGreaterThan(200);
    expect(transparent).toBeGreaterThan(400);
    // corners are empty
    expect(buf[3]).toBe(0);
    expect(buf[(36 * 36 - 1) * 4 + 3]).toBe(0);
  });
  it('lens centers are holes, lens rings are solid', () => {
    expect(glyphDistance(11, 20.4)).toBeGreaterThan(0); // hole
    expect(glyphDistance(11, 24.8)).toBeLessThan(0); // ring
    expect(glyphDistance(16, 14.4)).toBeLessThan(0); // bridge
    expect(glyphDistance(16, 24)).toBeGreaterThan(0); // between lenses, below the bridge
  });
});
