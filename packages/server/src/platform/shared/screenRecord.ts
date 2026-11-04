/**
 * Screen recording that runs until `screen-record-stop` (SPEC §5.5): one recording per device, stopped by
 * the user, the requested `durationSec` or the platform limit. The platform part starts the tool and says
 * how to end it; this part owns the single-recording rule, the limit timer and `DeviceInfo.recording`.
 */
import type { DeviceActionResult, DeviceRecording, ScreenRecordData } from '@durbun/protocol';
import { killProcess, spawnTracked } from '../exec';
import { fail, num } from './files';

/** A started recording tool. */
export interface RecordingProcess {
  /** Ask the tool to finish the file (SIGINT or the like). Called at most once. */
  stop(): void;
  /**
   * Settles when the tool is gone: ok with `{ url, file }` once the file is final, else a failure. `stopped`
   * says whether `stop()` was called: a tool that exits on its own before that is a failure unless it has
   * a usable file (e.g. Android's own time limit).
   */
  result(stopped: () => boolean): Promise<DeviceActionResult>;
}

interface Active {
  info: DeviceRecording;
  proc?: RecordingProcess;
  stopRequested: boolean;
  endedBy?: 'stop' | 'limit';
  stoppedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  done: Promise<DeviceActionResult>;
}

export class ScreenRecorder {
  private active: Active | undefined;
  private disposed = false;

  /** `publish` reports `DeviceInfo.recording` (undefined = not recording). */
  constructor(private readonly publish: (recording: DeviceRecording | undefined) => void) {}

  get recording(): DeviceRecording | undefined {
    return this.active?.info;
  }

  /**
   * `screen-record`: starts the tool and resolves with the file once the recording ended (stop, duration or
   * limit). `maxSec` is the platform limit; `params.durationSec` (optional) ends it earlier.
   */
  record(params: Record<string, unknown>, maxSec: number, start: () => RecordingProcess | Promise<RecordingProcess>): Promise<DeviceActionResult> {
    if (this.disposed) return Promise.resolve(fail('The device is gone', 'action.deviceOffline'));
    if (this.active) return Promise.resolve(fail('A screen recording is already running on this device', 'action.recording.busy'));
    const raw = num(params, 'durationSec');
    const limitSec = raw === undefined ? maxSec : Math.round(raw);
    if (limitSec < 1 || limitSec > maxSec) return Promise.resolve(fail(`durationSec must be between 1 and ${maxSec}`, 'action.invalidParams'));

    const a = { info: { startedAt: Date.now(), limitSec }, stopRequested: false } as Active;
    this.active = a;
    a.done = this.run(a, start);
    return a.done;
  }

  /** `screen-record-stop`: ends the running recording and resolves with the same result as its `screen-record`. */
  stop(): Promise<DeviceActionResult> {
    const a = this.active;
    if (!a) return Promise.resolve(fail('No screen recording is running on this device', 'action.recording.notRunning'));
    this.requestStop(a, 'stop');
    return a.done;
  }

  /** The device is gone or the driver stops: end a running recording (its `screen-record` still replies). */
  dispose(): void {
    this.disposed = true;
    if (this.active) this.requestStop(this.active, 'stop');
  }

  private async run(a: Active, start: () => RecordingProcess | Promise<RecordingProcess>): Promise<DeviceActionResult> {
    let result: DeviceActionResult;
    try {
      a.proc = await start();
      if (!this.disposed) this.publish(a.info);
      a.timer = setTimeout(() => this.requestStop(a, 'limit'), a.info.limitSec * 1000);
      a.timer.unref?.();
      // Stop pressed while the tool was starting.
      if (a.stopRequested) a.proc.stop();
      result = await a.proc.result(() => a.stopRequested);
    } catch (err) {
      result = fail(`Screen recording failed: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      clearTimeout(a.timer);
      this.active = undefined;
      if (!this.disposed) this.publish(undefined);
    }
    if (!result.ok || !isRecordData(result.data)) return result;
    const end = a.stoppedAt ?? Date.now();
    const data: ScreenRecordData = {
      ...result.data,
      durationSec: Math.max(1, Math.round((end - a.info.startedAt) / 1000)),
      // A tool that ended on its own (Android's time limit) counts as the limit.
      endedBy: a.endedBy ?? 'limit',
    };
    return { ...result, data };
  }

  private requestStop(a: Active, why: 'stop' | 'limit'): void {
    if (a.stopRequested) return;
    a.stopRequested = true;
    a.endedBy = why;
    a.stoppedAt = Date.now();
    clearTimeout(a.timer);
    try {
      a.proc?.stop();
    } catch {
      /* the result reports what happened */
    }
  }
}

/** How a recording tool ended. */
export interface ToolExit {
  code: number | null;
  /** Bounded tail-friendly stderr. */
  stderr: string;
  stopped: boolean;
}

/**
 * A host tool that records until SIGINT and then writes the file (`simctl io recordVideo`, `devicectl device
 * capture screen-record`). One that is still running `graceMs` after SIGINT is killed. `finish` turns the
 * exit into the action result.
 */
export function sigintRecording(
  cmd: string,
  args: readonly string[],
  graceMs: number,
  finish: (exit: ToolExit) => Promise<DeviceActionResult>,
): RecordingProcess {
  const child = spawnTracked(cmd, args);
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (d: string) => {
    if (stderr.length < 8000) stderr += d;
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(-1));
    child.once('exit', (code) => resolve(code));
  });
  return {
    stop() {
      try {
        child.kill('SIGINT');
      } catch {
        /* already gone */
      }
      const hung = setTimeout(() => void killProcess(child), graceMs);
      hung.unref?.();
      void exited.then(() => clearTimeout(hung));
    },
    async result(stopped) {
      const code = await exited;
      return finish({ code, stderr, stopped: stopped() });
    },
  };
}

function isRecordData(v: unknown): v is ScreenRecordData {
  return !!v && typeof v === 'object' && typeof (v as ScreenRecordData).url === 'string' && typeof (v as ScreenRecordData).file === 'string';
}
