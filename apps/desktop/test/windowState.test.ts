import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SIZE, fitBounds, MIN_SIZE, parseWindowState, readWindowState, writeWindowState } from '../src/windowState';

const laptop = { x: 0, y: 25, width: 1512, height: 920 }; // MacBook Pro 14" work area (menu bar 25 pt)
const external = { x: 1512, y: -300, width: 2560, height: 1415 };

describe('fitBounds', () => {
  it('keeps saved bounds that are on a display', () => {
    expect(fitBounds({ x: 100, y: 80, width: 1200, height: 800 }, [laptop])).toEqual({ x: 100, y: 80, width: 1200, height: 800 });
    expect(fitBounds({ x: 1700, y: -200, width: 1800, height: 1100 }, [laptop, external])).toEqual({ x: 1700, y: -200, width: 1800, height: 1100 });
  });
  it('drops bounds from a monitor that is gone (centered default size)', () => {
    const b = fitBounds({ x: 1700, y: -200, width: 1800, height: 1100 }, [laptop]);
    expect(b).toEqual({ width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height }); // 1360×860 fits 1512×920
    expect(b.x).toBeUndefined();
  });
  it('shrinks to the work area and pulls the window back on screen', () => {
    const b = fitBounds({ x: 1000, y: 10, width: 3000, height: 2000 }, [laptop]);
    expect(b).toEqual({ x: 0, y: 25, width: laptop.width, height: laptop.height });
  });
  it('never goes below the minimum size', () => {
    const b = fitBounds({ x: 10, y: 30, width: 300, height: 200 }, [laptop]);
    expect(b.width).toBe(MIN_SIZE.width);
    expect(b.height).toBe(MIN_SIZE.height);
  });
  it('defaults without saved state', () => {
    expect(fitBounds(undefined, [])).toEqual({ width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height });
  });
});

describe('window-state.json', () => {
  it('parses defensively', () => {
    expect(parseWindowState(null)).toEqual({});
    expect(parseWindowState({ bounds: { x: 'a' }, theme: 'blue', maximized: 'yes' })).toEqual({});
    expect(parseWindowState({ bounds: { x: 1.4, y: 2, width: 1000, height: 700 }, theme: 'light', maximized: true })).toEqual({
      bounds: { x: 1, y: 2, width: 1000, height: 700 },
      theme: 'light',
      maximized: true,
    });
  });
  it('round-trips through the file and survives garbage', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'durbun-desktop-state-'));
    const file = path.join(dir, 'sub', 'window-state.json');
    expect(readWindowState(file)).toEqual({});
    await writeWindowState(file, { bounds: { x: 5, y: 6, width: 1000, height: 700 }, theme: 'dark' });
    expect(readWindowState(file)).toEqual({ bounds: { x: 5, y: 6, width: 1000, height: 700 }, theme: 'dark' });
    writeFileSync(file, '{not json');
    expect(readWindowState(file)).toEqual({});
  });
});
