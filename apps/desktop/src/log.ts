/**
 * Diagnostic log file for the app (<userData>/logs/main.log). An app started from Finder has no
 * terminal, so console output of the main process (including the embedded server's logger, which
 * prints "HH:MM:SS.mmm LEVEL [scope] message" lines to stderr) is copied into this file as well.
 * Rotated while it is written: at 5 MB the file becomes main.1.log (the older one main.2.log), so an app that
 * stays in the menu bar for weeks keeps at most three files. Write errors are ignored.
 */
import { createWriteStream, mkdirSync, promises as fsp, renameSync, statSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

export const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** Rotated files kept next to the current one (main.1.log, main.2.log). */
export const KEPT_LOGS = 2;

export interface FileLog {
  readonly file: string;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  /** A logger for another component (`[scope]` instead of `[desktop]`): the embedded server's Logger. */
  scoped(scope: string, opts?: { debug?: boolean }): ScopedLogger;
}

/** The shape of packages/server's Logger (startServer(opts, { logger })). */
export interface ScopedLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  child(scope: string): ScopedLogger;
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

/** main.log → main.1.log, main.1.log → main.2.log … (the oldest is overwritten). */
export function rotatedName(file: string, n: number): string {
  return `${file.replace(/\.log$/, '')}.${n}.log`;
}

function shiftFiles(file: string, keep: number): void {
  for (let n = keep; n >= 1; n--) {
    try {
      renameSync(n === 1 ? file : rotatedName(file, n - 1), rotatedName(file, n));
    } catch {
      /* that file does not exist */
    }
  }
}

export function installFileLog(file: string, opts: { maxBytes?: number; keep?: number } = {}): FileLog {
  const maxBytes = opts.maxBytes ?? MAX_LOG_BYTES;
  const keep = Math.max(1, opts.keep ?? KEPT_LOGS);
  let stream: WriteStream | null = null;
  let bytes = 0;
  const open = () => {
    stream = createWriteStream(file, { flags: 'a' });
    stream.on('error', () => {
      stream = null;
    });
  };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      bytes = statSync(file).size;
      if (bytes > maxBytes) {
        shiftFiles(file, keep);
        bytes = 0;
      }
    } catch {
      /* no previous log */
    }
    open();
  } catch {
    stream = null;
  }

  const write = (line: string) => {
    if (!stream) return;
    try {
      const text = `${new Date().toISOString()} ${line}\n`;
      const size = Buffer.byteLength(text);
      if (bytes > 0 && bytes + size > maxBytes) {
        // The old stream finishes its pending writes into the renamed file (the descriptor follows it).
        stream.end();
        shiftFiles(file, keep);
        bytes = 0;
        open();
        if (!stream) return;
      }
      (stream as WriteStream).write(text);
      bytes += size;
    } catch {
      /* ignore */
    }
  };

  // Tee console.* into the file; the original output still goes to stdout/stderr when there is one.
  const original = {} as Record<ConsoleMethod, (...args: unknown[]) => void>;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as ConsoleMethod[]) {
    original[method] = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      write(format(...args));
      try {
        original[method](...args);
      } catch {
        /* EPIPE etc. when stdout is gone */
      }
    };
  }

  type Level = 'info' | 'warn' | 'error' | 'debug';
  const at =
    (level: Level, scope: string) =>
    (message: string, ...args: unknown[]) => {
      const text = `${level.toUpperCase().padEnd(5)} [${scope}] ${format(message, ...args)}`;
      write(text);
      try {
        original[level](text);
      } catch {
        /* no console */
      }
    };
  const scoped = (scope: string, opts: { debug?: boolean } = {}): ScopedLogger => ({
    debug: opts.debug ? at('debug', scope) : () => {},
    info: at('info', scope),
    warn: at('warn', scope),
    error: at('error', scope),
    child: (child) => scoped(`${scope}:${child}`, opts),
  });
  return { file, info: at('info', 'desktop'), warn: at('warn', 'desktop'), error: at('error', 'desktop'), debug: at('debug', 'desktop'), scoped };
}

/**
 * Crashpad keeps every minidump forever (<userData>/Crashpad/completed, pending). Drops dumps older than
 * `maxAgeMs` and all but the newest `maxCount`; returns how many were removed. Errors are ignored.
 */
export async function pruneCrashDumps(dir: string, opts: { now?: number; maxAgeMs?: number; maxCount?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
  const maxCount = opts.maxCount ?? 20;
  const dumps: { file: string; mtime: number }[] = [];
  for (const sub of ['completed', 'pending', 'new']) {
    let names: string[] = [];
    try {
      names = await fsp.readdir(path.join(dir, sub));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.dmp')) continue;
      const file = path.join(dir, sub, name);
      try {
        dumps.push({ file, mtime: (await fsp.stat(file)).mtimeMs });
      } catch {
        /* gone meanwhile */
      }
    }
  }
  dumps.sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const [i, d] of dumps.entries()) {
    if (i < maxCount && now - d.mtime <= maxAge) continue;
    try {
      await fsp.rm(d.file, { force: true });
      // Crashpad's .meta twin (pending uploads) goes with it.
      await fsp.rm(d.file.replace(/\.dmp$/, '.meta'), { force: true });
      removed++;
    } catch {
      /* ignore */
    }
  }
  return removed;
}
