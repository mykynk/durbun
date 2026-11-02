/** Small, allocation-conscious text helpers shared by the log parsers. */

/**
 * Splits a stream of text chunks into lines ('\n', optional preceding '\r' removed). A line longer
 * than `maxLength` is emitted in pieces so a runaway writer cannot grow memory without bound.
 */
export class LineSplitter {
  private rest = '';

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLength = 1024 * 1024,
  ) {}

  push(chunk: string): void {
    if (!chunk) return;
    let data = this.rest.length ? this.rest + chunk : chunk;
    this.rest = '';
    let start = 0;
    for (;;) {
      const nl = data.indexOf('\n', start);
      if (nl === -1) break;
      let end = nl;
      if (end > start && data.charCodeAt(end - 1) === 13) end -= 1;
      this.onLine(data.slice(start, end));
      start = nl + 1;
    }
    if (start < data.length) {
      data = data.slice(start);
      while (data.length > this.maxLength) {
        this.onLine(data.slice(0, this.maxLength));
        data = data.slice(this.maxLength);
      }
      this.rest = data;
    }
  }

  /** Emit a trailing partial line, if any. */
  flush(): void {
    if (!this.rest) return;
    let line = this.rest;
    this.rest = '';
    if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    this.onLine(line);
  }
}

// CSI sequences (colors, cursor moves) and OSC sequences terminated by BEL or ST.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Remove ANSI escape sequences (cheap no-op when there is no ESC). */
export function stripAnsi(s: string): string {
  return s.includes('\x1b') ? s.replace(ANSI_RE, '') : s;
}

/** basename for POSIX paths without importing node:path in hot loops. */
export function posixBasename(p: string): string {
  if (!p) return p;
  let end = p.length;
  while (end > 1 && p.charCodeAt(end - 1) === 47) end -= 1;
  const slash = p.lastIndexOf('/', end - 1);
  return p.slice(slash + 1, end);
}

/** Quote one argument for the POSIX shell on an Android device (`adb shell` joins its argv). */
export function shellQuote(arg: string): string {
  if (arg === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/** Quote and join a command for `adb shell`. */
export function shellJoin(args: readonly string[]): string {
  return args.map(shellQuote).join(' ');
}

/** Last non-empty lines of a text, joined (for error messages). */
export function tailLines(s: string, n = 3, maxLen = 400): string {
  const lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(-n).join(' · ').slice(0, maxLen);
}

/** Turn "Pixel_8_Pro" / "sdk_gphone64_arm64" style identifiers into readable names. */
export function humanizeModel(s: string): string {
  return s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Lowercase-ish identifier safe for file names. */
export function fileSafe(s: string, maxLen = 40): string {
  const out = s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return (out || 'device').slice(0, maxLen);
}
