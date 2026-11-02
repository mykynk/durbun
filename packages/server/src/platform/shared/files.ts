import fs from 'node:fs';
import path from 'node:path';
import type { DeviceActionResult } from '@durbun/protocol';
import type { DriverContext } from '../../types';
import { fileSafe } from './text';

let seq = 0;

/** e.g. "screenshot-Pixel-8-20261102-114301-123-1.png" (unique within this process). */
export function tempFileName(kind: string, deviceLabel: string, ext: string): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(
    d.getSeconds(),
  )}-${p(d.getMilliseconds(), 3)}`;
  seq += 1;
  return `${kind}-${fileSafe(deviceLabel)}-${stamp}-${seq}.${ext}`;
}

/** Width/height from a PNG's IHDR chunk. */
export function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24) return undefined;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return undefined;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a;
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

/** Write bytes into ctx.tempDir and build the screenshot action result. */
export async function saveScreenshot(
  ctx: DriverContext,
  deviceLabel: string,
  png: Buffer,
): Promise<DeviceActionResult> {
  await ensureDir(ctx.tempDir);
  const name = tempFileName('screenshot', deviceLabel, 'png');
  const file = path.join(ctx.tempDir, name);
  await fs.promises.writeFile(file, png);
  return screenshotResult(ctx, name, file, png);
}

export function screenshotResult(ctx: DriverContext, name: string, file: string, png: Buffer): DeviceActionResult {
  const size = pngSize(png);
  return {
    ok: true,
    message: 'Screenshot saved',
    code: 'action.screenshot.saved',
    data: { url: ctx.fileUrl(name), file, ...(size ?? {}) },
  };
}

/** Result for an action that failed (English message + i18n code). */
export function fail(message: string, code = 'action.failed'): DeviceActionResult {
  return { ok: false, message, code, error: message };
}

export function done(message: string, code = 'action.done', data?: unknown): DeviceActionResult {
  return data === undefined ? { ok: true, message, code } : { ok: true, message, code, data };
}

export function str(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function num(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export function bool(params: Record<string, unknown>, key: string): boolean | undefined {
  const v = params[key];
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/** Bundle id / package name validation (prevents option injection like "-k"). */
export function validAppId(id: string | undefined): id is string {
  return !!id && /^[A-Za-z0-9_][A-Za-z0-9_.\-:]*$/.test(id) && id.length <= 255;
}
