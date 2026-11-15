/**
 * The full device report a developer asks a tester for (`adb bugreport <file>.zip`, Android 7+): full logcat,
 * ANR traces, tombstones and dumpsys of every service, 10–50 MB, usually 1–3 minutes. adb writes the zip on
 * the Mac and prints its progress ("[ 42%] generating bugreport-….zip"); one report per phone at a time,
 * `cancel()` ends the adb client (the phone may finish its own copy in the background and drop it).
 */
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BugReportData, DeviceActionResult, DeviceBugReport } from '@durbun/protocol';
import type { DriverContext } from '../../types';
import { killProcess } from '../exec';
import { done, ensureDir, fail, tempFileName } from '../shared/files';
import { tailLines } from '../shared/text';

/** A report that takes longer than this is stopped (a phone that hangs in dumpstate). */
export const BUG_REPORT_MAX_MS = 15 * 60_000;

export interface BugReporterDeps {
  ctx: Pick<DriverContext, 'tempDir' | 'fileUrl'>;
  label: string;
  /** Start `adb -s <serial> bugreport <file>` (stdout and stderr piped); null when adb is not available. */
  spawn(file: string): ChildProcess | null;
  /** DeviceInfo.bugReport changed (undefined: none runs). */
  onState(state: DeviceBugReport | undefined): void;
}

/** "[ 42%] generating bugreport-…" → 42 (the last one in a chunk). */
export function parseBugReportProgress(text: string): number | undefined {
  let last: number | undefined;
  for (const m of text.matchAll(/\[\s*(\d{1,3})%\]/g)) {
    const n = Number(m[1]);
    if (n >= 0 && n <= 100) last = n;
  }
  return last;
}

export class BugReporter {
  private running?: { child: ChildProcess; cancelled: boolean; state: DeviceBugReport };
  private disposed = false;

  constructor(private readonly deps: BugReporterDeps) {}

  get busy(): boolean {
    return !!this.running;
  }

  /** Collect a report; replies when the zip is there (or it failed / was cancelled). */
  async collect(): Promise<DeviceActionResult> {
    if (this.disposed) return fail('The device is gone', 'action.deviceOffline');
    if (this.running) return fail('A device report is already being collected on this phone', 'action.bugReport.busy');
    await ensureDir(this.deps.ctx.tempDir);
    const name = tempFileName('bugreport', this.deps.label, 'zip');
    const file = path.join(this.deps.ctx.tempDir, name);
    const child = this.deps.spawn(file);
    if (!child) return fail('adb is not available', 'action.toolMissing', undefined);
    const startedAt = Date.now();
    const run = { child, cancelled: false, state: { startedAt } as DeviceBugReport };
    this.running = run;
    this.deps.onState({ ...run.state });
    let out = '';
    const onData = (d: Buffer | string) => {
      const text = d.toString();
      if (out.length < 16_000) out += text;
      const p = parseBugReportProgress(text);
      if (p !== undefined && p !== run.state.progress) {
        run.state = { ...run.state, progress: p };
        this.deps.onState({ ...run.state });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      run.cancelled = true;
      void killProcess(child);
    }, BUG_REPORT_MAX_MS);
    timer.unref?.();
    const code = await new Promise<number | null>((resolve) => {
      child.once('error', () => resolve(-1));
      child.once('exit', (c) => resolve(c));
    });
    clearTimeout(timer);
    this.running = undefined;
    if (!this.disposed) this.deps.onState(undefined);
    const st = await fs.promises.stat(file).catch(() => undefined);
    if (run.cancelled) {
      await fs.promises.rm(file, { force: true }).catch(() => undefined);
      const timedOut = Date.now() - startedAt >= BUG_REPORT_MAX_MS;
      return timedOut
        ? fail(`The device report did not finish within ${BUG_REPORT_MAX_MS / 60_000} minutes`, 'action.bugReport.failed')
        : fail('The device report was cancelled', 'action.bugReport.cancelled');
    }
    if (code !== 0 || !st || st.size === 0) {
      await fs.promises.rm(file, { force: true }).catch(() => undefined);
      const why = tailLines(out.replace(/\[\s*\d{1,3}%\][^\n\r]*[\r\n]*/g, '')) || `adb exited with code ${code ?? '?'}`;
      return fail(`The device report failed: ${why}`, 'action.bugReport.failed');
    }
    const data: BugReportData = {
      url: this.deps.ctx.fileUrl(name),
      file,
      bytes: st.size,
      durationSec: Math.round((Date.now() - startedAt) / 1000),
    };
    return done('Device report saved', 'action.bugReport.saved', data);
  }

  async cancel(): Promise<DeviceActionResult> {
    const run = this.running;
    if (!run) return fail('No device report is being collected', 'action.bugReport.notRunning');
    run.cancelled = true;
    await killProcess(run.child);
    return done('Device report cancelled', 'action.bugReport.cancelled');
  }

  dispose(): void {
    this.disposed = true;
    const run = this.running;
    if (run) {
      run.cancelled = true;
      void killProcess(run.child);
    }
  }
}
