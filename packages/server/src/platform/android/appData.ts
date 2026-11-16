/**
 * `app-data` on Android: the app's data folder (/data/user/<user>/<package>) through `run-as`, which only works for
 * debuggable apps (a debug build). `run-as` starts in that folder; the phone's `tar` streams it over `adb exec-out`
 * (binary safe; the phone's stderr arrives on the same stream, so the first block tells a tar from an error text).
 * Cache folders are left out.
 */
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { DeviceActionResult } from '@durbun/protocol';
import type { DriverContext } from '../../types';
import { killProcess } from '../exec';
import { ANDROID_SKIPPED, APP_DATA_MAX_BYTES, APP_DATA_TIMEOUT_MS, appDataResult, appDataTarget, writeTarGz } from '../shared/appData';
import { fail } from '../shared/files';
import { looksLikeTar } from '../shared/tarStream';
import { shellQuote, tailLines } from '../shared/text';

/** Printed by the script below instead of a tar: the phone has no `tar`, or the folder holds nothing to copy. */
export const NO_TAR_MARK = 'durbun-no-tar';
export const EMPTY_MARK = 'durbun-empty';

/** The command `adb exec-out` runs on the phone (one string, the phone's shell parses it). */
export function runAsTarCommand(appId: string, userId?: number): string {
  const skip = ['.', '..', ...ANDROID_SKIPPED].join('|');
  const script = [
    `command -v tar >/dev/null 2>&1 || { echo ${NO_TAR_MARK}; exit 0; }`,
    `set -- $(ls -a | grep -vxE "${skip}")`,
    `[ $# -gt 0 ] || { echo ${EMPTY_MARK}; exit 0; }`,
    'tar -cf - "$@" 2>/dev/null',
  ].join('; ');
  const user = userId === undefined ? '' : ` --user ${userId}`;
  return `run-as${user} ${shellQuote(appId)} sh -c ${shellQuote(script)}`;
}

export interface RunAsFailure {
  code: string;
  message: string;
  params?: Record<string, string>;
}

/**
 * What a non-tar answer means. Wording of `run-as` (AOSP system/core/run-as/run-as.cpp): "run-as: unknown
 * package: <pkg>", "run-as: package not debuggable: <pkg>"; before Android 7: "run-as: Package '<pkg>' is
 * unknown" / "… is not debuggable". A data folder still locked (file-based encryption before the first unlock)
 * fails with ENOKEY, "Required key not available".
 */
export function parseRunAsOutput(text: string, appId: string): RunAsFailure {
  const t = text.trim();
  if (t === '' || t.includes(EMPTY_MARK)) return { code: 'action.appData.empty', message: `${appId} has no data to copy` };
  if (t.includes(NO_TAR_MARK)) return { code: 'action.appData.noTar', message: 'This phone has no tar command' };
  if (/unknown package|Package '[^']*' is unknown/i.test(t)) {
    return { code: 'action.appData.notInstalled', message: `${appId} is not installed for this user`, params: { appId } };
  }
  if (/not debuggable|Package '[^']*' is not debuggable/i.test(t)) {
    return { code: 'action.appData.notDebuggable', message: `${appId} is not debuggable (not a debug build)`, params: { appId } };
  }
  if (/Required key not available|ENOKEY/i.test(t)) {
    return { code: 'action.appData.locked', message: 'The phone has not been unlocked since it started' };
  }
  if (/device offline|device '[^']*' not found|no devices\/emulators found|device unauthorized/i.test(t)) {
    return { code: 'action.deviceOffline', message: 'The device is not reachable' };
  }
  const detail = tailLines(t.replace(/[^\x20-\x7e\n\t]/g, ''));
  return { code: 'action.appData.failed', message: `Could not copy the app's data: ${detail}`, params: { detail } };
}

export interface AndroidAppDataDeps {
  ctx: Pick<DriverContext, 'tempDir' | 'fileUrl'>;
  label: string;
  /** Start `adb -s <serial> exec-out <command>` (stdout and stderr piped); null when adb is not available. */
  spawn(command: string): ChildProcess | null;
  maxBytes?: number;
  timeoutMs?: number;
}

/** Copy the data of `appId` (debuggable) into one .tar.gz in the temp folder. */
export async function pullAndroidAppData(deps: AndroidAppDataDeps, appId: string, userId?: number): Promise<DeviceActionResult> {
  const child = deps.spawn(runAsTarCommand(appId, userId));
  if (!child?.stdout) return fail('adb is not available', 'action.toolMissing', undefined, { tool: 'adb' });
  const startedAt = Date.now();
  const stdout = child.stdout;
  let errText = '';
  child.stderr?.on('data', (d: Buffer) => {
    if (errText.length < 16_000) errText += d.toString();
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(-1));
    child.once('exit', (c) => resolve(c));
  });

  // Read until the first tar block is here (or the stream ends with a text).
  const iterator = (stdout as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  const firstChunks: Buffer[] = [];
  let have = 0;
  let ended = false;
  const firstTimer = setTimeout(() => void killProcess(child), Math.min(deps.timeoutMs ?? APP_DATA_TIMEOUT_MS, 60_000));
  firstTimer.unref?.();
  try {
    while (have < 512) {
      const r = await iterator.next();
      if (r.done) {
        ended = true;
        break;
      }
      firstChunks.push(r.value);
      have += r.value.length;
    }
  } catch {
    ended = true;
  } finally {
    clearTimeout(firstTimer);
  }
  const head = Buffer.concat(firstChunks);

  if (!looksLikeTar(head)) {
    let text = head.toString('utf8');
    if (!ended) {
      // An error text longer than one block: read a little more, then stop the phone's side.
      try {
        while (text.length < 16_000) {
          const r = await iterator.next();
          if (r.done) break;
          text += r.value.toString('utf8');
        }
      } catch {
        // ignore
      }
      await killProcess(child);
    }
    const code = await exited;
    const out = `${text}\n${errText}`;
    if (code === -1 && out.trim() === '') return fail('adb is not available', 'action.toolMissing', undefined, { tool: 'adb' });
    const f = parseRunAsOutput(out, appId);
    return fail(f.message, f.code, undefined, f.params);
  }

  const target = await appDataTarget(deps.ctx, deps.label, appId);
  // The last bytes seen: a whole archive ends with zero blocks; a cut connection does not.
  let tail: Buffer = Buffer.alloc(0);
  const keepTail = (b: Buffer) => {
    tail = b.length >= 1024 ? b.subarray(b.length - 1024) : Buffer.concat([tail, b]).subarray(-1024);
  };
  async function* rest(): AsyncGenerator<Buffer> {
    keepTail(head);
    yield head;
    for (;;) {
      const r = await iterator.next();
      if (r.done) return;
      keepTail(r.value);
      yield r.value;
    }
  }
  const out = await writeTarGz(rest(), target.file, {
    maxBytes: deps.maxBytes ?? APP_DATA_MAX_BYTES,
    timeoutMs: deps.timeoutMs ?? APP_DATA_TIMEOUT_MS,
    onStop: () => void killProcess(child),
  });
  if (!out.ok) await killProcess(child);
  await exited;
  if (out.ok && !tail.every((b) => b === 0)) {
    await fs.promises.rm(target.file, { force: true }).catch(() => undefined);
    return fail('The copy stopped before the end (the connection to the phone dropped?)', 'action.appData.incomplete');
  }
  return appDataResult(deps.ctx, target, appId, startedAt, out);
}
