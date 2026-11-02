/**
 * Window bounds + theme remembered between launches (<userData>/window-state.json). Restored bounds
 * are fitted to the displays that exist now (an external monitor may be gone).
 */
import { promises as fsp, readFileSync } from 'node:fs';
import path from 'node:path';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Theme = 'dark' | 'light';

export interface WindowState {
  bounds?: Rect;
  maximized?: boolean;
  theme?: Theme;
}

export const MIN_SIZE = { width: 900, height: 600 } as const;
export const DEFAULT_SIZE = { width: 1360, height: 860 } as const;

/** Background colors of the UI themes (packages/ui/src/styles/tokens.css --bg-app). */
export const THEME_BACKGROUND: Record<Theme, string> = { dark: '#0b0d12', light: '#f5f6f9' };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseWindowState(raw: unknown): WindowState {
  const out: WindowState = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const b = r.bounds as Record<string, unknown> | undefined;
  if (b && isNum(b.x) && isNum(b.y) && isNum(b.width) && isNum(b.height) && b.width > 0 && b.height > 0) {
    out.bounds = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
  }
  if (typeof r.maximized === 'boolean') out.maximized = r.maximized;
  if (r.theme === 'dark' || r.theme === 'light') out.theme = r.theme;
  return out;
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Bounds to open with: the saved ones when their top strip (where the title bar is) is on a display,
 * shrunk to that display's work area; otherwise the default size, centered by the caller (no x/y).
 */
export function fitBounds(saved: Rect | undefined, workAreas: Rect[]): Partial<Rect> & { width: number; height: number } {
  const primary = workAreas[0];
  const fallback = () => {
    const width = primary ? Math.max(MIN_SIZE.width, Math.min(DEFAULT_SIZE.width, primary.width - 40)) : DEFAULT_SIZE.width;
    const height = primary ? Math.max(MIN_SIZE.height, Math.min(DEFAULT_SIZE.height, primary.height - 40)) : DEFAULT_SIZE.height;
    return { width, height };
  };
  if (!saved || workAreas.length === 0) return fallback();
  const titleStrip: Rect = { x: saved.x, y: saved.y, width: saved.width, height: 40 };
  let best: Rect | undefined;
  let bestArea = 0;
  for (const area of workAreas) {
    const o = overlap(titleStrip, area);
    if (o > bestArea) {
      bestArea = o;
      best = area;
    }
  }
  // At least 100 px of the title strip must be reachable.
  if (!best || bestArea < 100 * 40) return fallback();
  const width = Math.max(MIN_SIZE.width, Math.min(saved.width, best.width));
  const height = Math.max(MIN_SIZE.height, Math.min(saved.height, best.height));
  const x = Math.min(Math.max(saved.x, best.x), best.x + best.width - Math.min(width, best.width));
  const y = Math.min(Math.max(saved.y, best.y), best.y + best.height - Math.min(height, best.height));
  return { x, y, width, height };
}

export function readWindowState(file: string): WindowState {
  try {
    return parseWindowState(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

/** Atomic write (tmp + rename); errors are ignored (state is a convenience). */
export async function writeWindowState(file: string, state: WindowState): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    await fsp.rename(tmp, file);
  } catch {
    /* ignore */
  }
}
