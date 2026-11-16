/**
 * Pulling an app's own data folder (`app-data` action) into one .tar.gz in the temp folder. The tar stream comes
 * from the phone (Android `run-as … tar`) or from a folder on this Mac (simulator container); either way it is
 * counted, gzipped and written as it arrives, and stops past APP_DATA_MAX_BYTES.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import type { AppDataPullData, DeviceActionResult } from '@durbun/protocol';
import type { DriverContext } from '../../types';
import { done, ensureDir, fail, tempFileName } from './files';

/** Stop past this much data (before compression). */
export const APP_DATA_MAX_BYTES = 1024 * 1024 * 1024;
/** A pull that takes longer than this is stopped. */
export const APP_DATA_TIMEOUT_MS = 10 * 60_000;

/** Folders left out: caches the app can rebuild, and the native-library link of Android apps. */
export const ANDROID_SKIPPED = ['cache', 'code_cache', 'lib'] as const;
export const SIM_SKIPPED = ['Library/Caches', 'Library/SplashBoard', 'tmp'] as const;

export type ArchiveOutcome =
  | { ok: true; bytes: number; rawBytes: number }
  | { ok: false; reason: 'tooLarge' | 'timeout' | 'aborted' | 'error'; message: string };

class Stop extends Error {
  constructor(readonly reason: 'tooLarge' | 'timeout') {
    super(reason);
  }
}

/**
 * Gzip a tar stream into `file`. Removes the file on any failure. `signal` aborts from outside (device gone);
 * `onStop` runs when the size or time limit hits (kill the producer).
 */
export async function writeTarGz(
  source: AsyncIterable<Buffer> | Readable,
  file: string,
  opts: { maxBytes?: number; timeoutMs?: number; signal?: AbortSignal; onStop?: () => void } = {},
): Promise<ArchiveOutcome> {
  const maxBytes = opts.maxBytes ?? APP_DATA_MAX_BYTES;
  let rawBytes = 0;
  const ac = new AbortController();
  let stopped: Stop | undefined;
  const stop = (why: Stop) => {
    if (stopped) return;
    stopped = why;
    opts.onStop?.();
    ac.abort(why);
  };
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      rawBytes += chunk.length;
      if (rawBytes > maxBytes) {
        const e = new Stop('tooLarge');
        stop(e);
        cb(e);
        return;
      }
      cb(null, chunk);
    },
  });
  const timer = setTimeout(() => stop(new Stop('timeout')), opts.timeoutMs ?? APP_DATA_TIMEOUT_MS);
  timer.unref?.();
  const onOuterAbort = () => ac.abort(new Error('aborted'));
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  try {
    const input = source instanceof Readable ? source : Readable.from(source);
    await pipeline(input, counter, zlib.createGzip({ level: 6 }), fs.createWriteStream(file), { signal: ac.signal });
    const st = await fs.promises.stat(file);
    return { ok: true, bytes: st.size, rawBytes };
  } catch (e) {
    await fs.promises.rm(file, { force: true }).catch(() => undefined);
    if (stopped) return { ok: false, reason: stopped.reason, message: stopped.reason };
    if (opts.signal?.aborted) return { ok: false, reason: 'aborted', message: 'aborted' };
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** Where a pull for `appId` goes: a fresh name directly inside the temp folder (served under /api/files). */
export async function appDataTarget(ctx: Pick<DriverContext, 'tempDir'>, label: string, appId: string): Promise<{ name: string; file: string }> {
  await ensureDir(ctx.tempDir);
  const name = tempFileName('app-data', `${appId}-${label}`, 'tar.gz');
  return { name, file: path.join(ctx.tempDir, name) };
}

/** The reply for a finished pull, or the failure for a stopped one. */
export function appDataResult(
  ctx: Pick<DriverContext, 'fileUrl'>,
  target: { name: string; file: string },
  appId: string,
  startedAt: number,
  out: ArchiveOutcome,
): DeviceActionResult {
  if (!out.ok) {
    if (out.reason === 'tooLarge') {
      return fail(`The app's data is larger than ${APP_DATA_MAX_BYTES / 1024 ** 3} GiB`, 'action.appData.tooLarge', undefined, { limit: '1 GiB' });
    }
    if (out.reason === 'timeout') {
      return fail(`The copy did not finish within ${APP_DATA_TIMEOUT_MS / 60_000} minutes`, 'action.appData.timeout', undefined, { minutes: APP_DATA_TIMEOUT_MS / 60_000 });
    }
    if (out.reason === 'aborted') return fail('The device is gone', 'action.deviceOffline');
    return fail(`Could not save the app's data: ${out.message}`, 'action.appData.failed', undefined, { detail: out.message.slice(0, 400) });
  }
  const data: AppDataPullData = {
    url: ctx.fileUrl(target.name),
    file: target.file,
    fileName: target.name,
    appId,
    bytes: out.bytes,
    rawBytes: out.rawBytes,
    durationSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
  };
  return done(`Saved the data of ${appId}`, 'action.appData.saved', data);
}

const running = new Set<string>();

/** One pull per device at a time. */
export async function oncePerDevice(deviceId: string, fn: () => Promise<DeviceActionResult>): Promise<DeviceActionResult> {
  if (running.has(deviceId)) return fail("This device's app data is already being copied", 'action.appData.busy');
  running.add(deviceId);
  try {
    return await fn();
  } finally {
    running.delete(deviceId);
  }
}
