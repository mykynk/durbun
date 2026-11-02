/**
 * Diagnostic log file for the app (<userData>/logs/main.log). An app started from Finder has no
 * terminal, so console output of the main process (including the embedded server's logger, which
 * prints "HH:MM:SS.mmm LEVEL [scope] message" lines to stderr) is copied into this file as well.
 * Rotated at 5 MB; write errors are ignored.
 */
import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

const MAX_BYTES = 5 * 1024 * 1024;

export interface FileLog {
  readonly file: string;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

export function installFileLog(file: string): FileLog {
  let stream: WriteStream | null = null;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, file.replace(/\.log$/, '') + '.1.log');
    } catch {
      /* no previous log */
    }
    stream = createWriteStream(file, { flags: 'a' });
    stream.on('error', () => {
      stream = null;
    });
  } catch {
    stream = null;
  }

  const write = (line: string) => {
    if (!stream) return;
    try {
      stream.write(`${new Date().toISOString()} ${line}\n`);
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

  const at =
    (level: 'info' | 'warn' | 'error' | 'debug') =>
    (message: string, ...args: unknown[]) => {
      const text = `${level.toUpperCase().padEnd(5)} [desktop] ${format(message, ...args)}`;
      write(text);
      try {
        original[level === 'debug' ? 'debug' : level === 'info' ? 'info' : level](text);
      } catch {
        /* no console */
      }
    };
  return { file, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
}
