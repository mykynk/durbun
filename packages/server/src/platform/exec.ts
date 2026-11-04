/**
 * Child-process helpers for the platform drivers.
 *
 * Rules (SPEC §5.5): every external command is spawned directly (never through a shell), with a
 * timeout, and failures are returned as data. Long-running streams (logcat, idevicesyslog,
 * `log stream`) are tracked so they can be killed on stop and, as a last resort, on process exit.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from '../types';
import { LineSplitter } from './shared/text';
import { Backoff } from './shared/timing';

export type ExtraEnv = Record<string, string | undefined>;

export interface RunOptions {
  /** Kill the command (SIGKILL) after this many ms. Default 15 000. */
  timeoutMs?: number;
  /** Extra environment variables (merged over process.env). */
  env?: ExtraEnv;
  /** Max stdout bytes kept; the command is killed when exceeded. Default 32 MiB. */
  maxBuffer?: number;
  /** Written to stdin (stdin is closed otherwise). */
  input?: string | Buffer;
  cwd?: string;
}

export interface RunResult<T = string> {
  /** Exit code 0, no spawn error, no timeout, no overflow. */
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: T;
  stderr: string;
  timedOut: boolean;
  /** Spawn/timeout/overflow problem in English (absent when the command simply exited non-zero). */
  error?: string;
  /** e.g. 'ENOENT', 'EACCES', 'ETIMEDOUT', 'EMAXBUFFER'. */
  errorCode?: string;
}

/* ───────────── live child registry (safety net against orphaned streams) ───────────── */

const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function track(child: ChildProcess): void {
  liveChildren.add(child);
  const forget = () => liveChildren.delete(child);
  child.once('exit', forget);
  child.once('error', forget);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const c of liveChildren) {
        try {
          c.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    });
  }
}

/** Number of tracked live child processes (diagnostics / tests). */
export function liveChildCount(): number {
  return liveChildren.size;
}

/**
 * Spawn a tracked child (stdin ignored, stdout ignored unless `opts.stdout`, stderr piped) for one-off long
 * operations such as screen recordings. The caller owns its lifetime (killProcess).
 */
export function spawnTracked(cmd: string, args: readonly string[], env?: ExtraEnv, opts: { stdout?: boolean } = {}): ChildProcess {
  const child = spawn(cmd, [...args], {
    env: mergedEnv(env),
    stdio: ['ignore', opts.stdout ? 'pipe' : 'ignore', 'pipe'],
    windowsHide: true,
  });
  track(child);
  return child;
}

function mergedEnv(extra?: ExtraEnv): NodeJS.ProcessEnv {
  if (!extra) return process.env;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function describeSpawnError(cmd: string, err: NodeJS.ErrnoException): string {
  if (err.code === 'ENOENT') return `${cmd}: command not found`;
  if (err.code === 'EACCES') return `${cmd}: permission denied`;
  return `${cmd}: ${err.message}`;
}

function runRaw(cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult<Buffer>> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBuffer = opts.maxBuffer ?? 32 * 1024 * 1024;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: RunResult<Buffer>) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ChildProcess;
    try {
      child = spawn(cmd, [...args], {
        env: mergedEnv(opts.env),
        cwd: opts.cwd,
        stdio: [opts.input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      finish({
        ok: false,
        code: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: '',
        timedOut: false,
        error: describeSpawnError(cmd, err),
        errorCode: err.code ?? 'ESPAWN',
      });
      return;
    }
    track(child);
    const out: Buffer[] = [];
    let outLen = 0;
    const errChunks: Buffer[] = [];
    let errLen = 0;
    let overflow = false;
    let timedOut = false;
    let spawnError: NodeJS.ErrnoException | undefined;

    child.stdout?.on('data', (d: Buffer) => {
      if (overflow) return;
      if (outLen + d.length > maxBuffer) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(d);
      outLen += d.length;
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (errLen < 256 * 1024) {
        errChunks.push(d);
        errLen += d.length;
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnError = err;
      if (child.pid === undefined) {
        clearTimeout(timer);
        finish({
          ok: false,
          code: null,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: '',
          timedOut: false,
          error: describeSpawnError(cmd, err),
          errorCode: err.code ?? 'ESPAWN',
        });
      }
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out, outLen);
      const stderr = Buffer.concat(errChunks, errLen).toString('utf8');
      let error: string | undefined;
      let errorCode: string | undefined;
      if (spawnError) {
        error = describeSpawnError(cmd, spawnError);
        errorCode = spawnError.code ?? 'ESPAWN';
      } else if (timedOut) {
        error = `${cmd} timed out after ${Math.round(timeoutMs / 1000)} s`;
        errorCode = 'ETIMEDOUT';
      } else if (overflow) {
        error = `${cmd} produced more than ${maxBuffer} bytes of output`;
        errorCode = 'EMAXBUFFER';
      }
      finish({
        ok: !error && code === 0,
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        error,
        errorCode,
      });
    });
    if (opts.input != null && child.stdin) {
      child.stdin.on('error', () => {
        /* EPIPE when the command exits early */
      });
      child.stdin.end(opts.input);
    }
  });
}

/** Run a command and collect UTF-8 output. Never rejects. */
export async function run(cmd: string, args: readonly string[], opts?: RunOptions): Promise<RunResult<string>> {
  const r = await runRaw(cmd, args, opts);
  return { ...r, stdout: r.stdout.toString('utf8') };
}

/** Run a command and collect raw stdout bytes (screenshots). Never rejects. */
export function runBuffer(cmd: string, args: readonly string[], opts?: RunOptions): Promise<RunResult<Buffer>> {
  return runRaw(cmd, args, opts);
}

/** Short English failure text for a RunResult: spawn error, else last stderr/stdout line, else exit code. */
export function failureText(r: RunResult<string | Buffer>, fallback = 'command failed'): string {
  if (r.error) return r.error;
  const pick = (s: string) =>
    s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-3)
      .join(' · ');
  const err = pick(r.stderr);
  if (err) return err.slice(0, 500);
  const out = typeof r.stdout === 'string' ? pick(r.stdout) : '';
  if (out) return out.slice(0, 500);
  if (r.signal) return `${fallback} (signal ${r.signal})`;
  return `${fallback} (exit code ${r.code ?? '?'})`;
}

/** SIGTERM, then SIGKILL after `graceMs`; resolves once the process is gone (or after a hard cap). */
export function killProcess(child: ChildProcess, graceMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      clearTimeout(capTimer);
      resolve();
    };
    child.once('exit', finish);
    try {
      child.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, graceMs);
    const capTimer = setTimeout(finish, graceMs + 2000);
    killTimer.unref?.();
    capTimer.unref?.();
  });
}

/* ───────────── managed streaming process (restart with backoff) ───────────── */

export interface StreamSpec {
  cmd: string;
  args: string[];
  env?: ExtraEnv;
}

export interface StreamExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Last stderr lines (English, trimmed). */
  stderrTail: string;
  ranForMs: number;
  /** True when the process produced at least one stdout line. */
  hadOutput: boolean;
  /** The exit was requested through stop(). */
  stopped: boolean;
  willRestart: boolean;
  /** Restart delay when willRestart. */
  restartInMs?: number;
  /** Spawn error text (ENOENT …). */
  error?: string;
  errorCode?: string;
}

export interface StreamProcessOptions {
  name: string;
  logger: Logger;
  /** Recomputed for every (re)start; return null when the tool is unavailable. */
  spec: () => StreamSpec | null;
  onLine: (line: string) => void;
  onStderrLine?: (line: string) => void;
  onSpawn?: (attempt: number) => void;
  /** First stdout data of a run. */
  onFirstOutput?: () => void;
  onExit?: (info: StreamExitInfo) => void;
  /** Consulted when the process exits on its own (device still online?). Default: true. */
  shouldRestart?: (info: Omit<StreamExitInfo, 'willRestart' | 'restartInMs' | 'stopped'>) => boolean;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** A run longer than this resets the backoff. */
  stableAfterMs?: number;
  /** Max length of one line before it is force-split. */
  maxLineLength?: number;
}

/**
 * A long-running child process whose stdout is consumed line by line. When it exits on its own it
 * is restarted with exponential backoff while `shouldRestart()` says so; `stop()` kills it for good.
 */
export class StreamProcess {
  private child?: ChildProcess;
  private stopped = true;
  private restartTimer?: NodeJS.Timeout;
  private attempt = 0;
  private readonly backoff: Backoff;
  private startedAt = 0;
  private exitWaiters: Array<() => void> = [];

  constructor(private readonly opts: StreamProcessOptions) {
    this.backoff = new Backoff(opts.backoffInitialMs ?? 1000, opts.backoffMaxMs ?? 15_000);
  }

  get running(): boolean {
    return !!this.child;
  }

  get active(): boolean {
    return !this.stopped;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Start (or keep running). Returns false when the spec is unavailable. */
  start(): boolean {
    this.stopped = false;
    if (this.child) return true;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    return this.spawnOnce();
  }

  /** Kill the current run and start again immediately (backoff reset). */
  async restart(): Promise<boolean> {
    await this.stop();
    this.backoff.reset();
    return this.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      this.exitWaiters.push(finish);
      void killProcess(child).then(() => {
        // 'close' may lag behind 'exit' (stdio held elsewhere); do not wait forever for it.
        setTimeout(finish, 50).unref?.();
      });
    });
    // Detach even if 'close' never came, so a later start() spawns a fresh process.
    if (this.child === child) this.child = undefined;
  }

  private spawnOnce(): boolean {
    const spec = this.opts.spec();
    if (!spec) return false;
    const { logger, name } = this.opts;
    this.attempt += 1;
    this.startedAt = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(spec.cmd, spec.args, {
        env: mergedEnv(spec.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      this.handleExit(null, null, '', false, describeSpawnError(spec.cmd, err), err.code);
      return true;
    }
    this.child = child;
    track(child);
    logger.debug(`${name}: spawned pid ${child.pid ?? '?'} (${spec.cmd} ${spec.args.join(' ')})`);
    this.opts.onSpawn?.(this.attempt);

    let hadOutput = false;
    const stderrLines: string[] = [];
    let spawnError: NodeJS.ErrnoException | undefined;
    const maxLine = this.opts.maxLineLength ?? 1024 * 1024;
    const outSplitter = new LineSplitter((line) => {
      if (this.child !== child) return;
      try {
        this.opts.onLine(line);
      } catch (e) {
        logger.warn(`${name}: line handler failed: ${(e as Error).message}`);
      }
    }, maxLine);
    const errSplitter = new LineSplitter((line) => {
      const t = line.trim();
      if (!t) return;
      stderrLines.push(t);
      if (stderrLines.length > 20) stderrLines.shift();
      try {
        this.opts.onStderrLine?.(t);
      } catch {
        /* ignore */
      }
    }, 64 * 1024);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (!hadOutput) {
        hadOutput = true;
        try {
          this.opts.onFirstOutput?.();
        } catch {
          /* ignore */
        }
      }
      outSplitter.push(chunk);
    });
    child.stderr?.on('data', (chunk: string) => errSplitter.push(chunk));
    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnError = err;
      if (child.pid === undefined) {
        // Spawn failed: no 'close' is guaranteed.
        if (this.child === child) this.child = undefined;
        this.handleExit(null, null, '', false, describeSpawnError(spec.cmd, err), err.code);
      }
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      outSplitter.flush();
      errSplitter.flush();
      if (this.child !== child) return;
      this.child = undefined;
      const waiters = this.exitWaiters;
      this.exitWaiters = [];
      for (const w of waiters) w();
      if (spawnError && child.pid === undefined) return; // already handled
      this.handleExit(
        code,
        signal,
        stderrLines.slice(-5).join(' · '),
        hadOutput,
        spawnError ? describeSpawnError(spec.cmd, spawnError) : undefined,
        spawnError?.code,
      );
    });
    return true;
  }

  private handleExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    stderrTail: string,
    hadOutput: boolean,
    error?: string,
    errorCode?: string,
  ): void {
    const ranForMs = Date.now() - this.startedAt;
    const base = { code, signal, stderrTail, ranForMs, hadOutput, error, errorCode };
    if (this.stopped) {
      this.opts.logger.debug(`${this.opts.name}: stopped (code ${code}, signal ${signal})`);
      try {
        this.opts.onExit?.({ ...base, stopped: true, willRestart: false });
      } catch {
        /* ignore */
      }
      return;
    }
    if (ranForMs >= (this.opts.stableAfterMs ?? 20_000)) this.backoff.reset();
    let willRestart = true;
    try {
      willRestart = this.opts.shouldRestart ? this.opts.shouldRestart(base) : true;
    } catch {
      willRestart = false;
    }
    const restartInMs = willRestart ? this.backoff.next() : undefined;
    this.opts.logger.debug(
      `${this.opts.name}: exited (code ${code}, signal ${signal}${error ? `, ${error}` : ''})` +
        (willRestart ? `, restarting in ${restartInMs} ms` : ''),
    );
    try {
      this.opts.onExit?.({ ...base, stopped: false, willRestart, restartInMs });
    } catch {
      /* ignore */
    }
    if (willRestart && !this.stopped) {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        if (!this.stopped && !this.child) this.spawnOnce();
      }, restartInMs);
      this.restartTimer.unref?.();
    } else {
      this.stopped = true;
    }
  }
}
