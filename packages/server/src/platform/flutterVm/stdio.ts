/**
 * `Stdout` / `Stderr` stream events → readable log lines.
 *
 * WriteEvents carry raw chunks (base64 `bytes`): `stdout.write('a ')` and `print('b')` arrive as separate
 * events ("a ", "b\n"), so chunks are assembled into lines; an unterminated tail is flushed after a short
 * idle delay. For Flutter apps the `flutter: ` prefix is dropped and Flutter error boxes
 * (`══╡ EXCEPTION CAUGHT BY … ╞═══` … `════`), which the framework prints line by line, are folded into a
 * single `flutter-error` entry.
 */
import type { AppLog } from './logRecord';

export interface StdioLine {
  text: string;
  ts: number;
}

export class LineAssembler {
  private buffer = '';
  private bufferTs = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onLine: (line: StdioLine) => void,
    private readonly flushDelayMs = 100,
  ) {}

  push(chunk: string, ts: number): void {
    if (!chunk) return;
    if (!this.buffer) this.bufferTs = ts;
    const parts = (this.buffer + chunk).split('\n');
    this.buffer = parts.pop() ?? '';
    let lineTs = this.bufferTs;
    for (const part of parts) {
      this.onLine({ text: part.endsWith('\r') ? part.slice(0, -1) : part, ts: lineTs });
      lineTs = ts;
    }
    if (parts.length > 0) this.bufferTs = ts;
    this.schedule();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.buffer) return;
    const text = this.buffer;
    this.buffer = '';
    this.onLine({ text: text.endsWith('\r') ? text.slice(0, -1) : text, ts: this.bufferTs });
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.buffer) return;
    this.timer = setTimeout(() => this.flush(), this.flushDelayMs);
    this.timer.unref?.();
  }
}

const BOX_START_RE = /══╡ .+ ╞═/;
const BOX_END_RE = /^═{8,}\s*$/;
const ANOTHER_EXCEPTION_RE = /^Another exception was thrown: /;

export interface GroupedLine extends StdioLine {
  flutterError?: boolean;
}

export interface GrouperOptions {
  /** Close an unterminated box after this much silence (debugPrint is throttled, boxes trickle in). */
  idleMs: number;
  maxMs: number;
  maxLines: number;
}

export class FlutterErrorGrouper {
  private open: { lines: string[]; ts: number; startedAt: number } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly opts: GrouperOptions;

  constructor(
    private readonly emit: (line: GroupedLine) => void,
    options: Partial<GrouperOptions> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.opts = { idleMs: 1500, maxMs: 30_000, maxLines: 2000, ...options };
  }

  push(line: StdioLine): void {
    if (this.open) {
      this.open.lines.push(line.text);
      if (
        BOX_END_RE.test(line.text) ||
        this.open.lines.length >= this.opts.maxLines ||
        this.now() - this.open.startedAt >= this.opts.maxMs
      ) {
        this.close();
      } else {
        this.arm();
      }
      return;
    }
    if (BOX_START_RE.test(line.text)) {
      this.open = { lines: [line.text], ts: line.ts, startedAt: this.now() };
      this.arm();
      return;
    }
    if (ANOTHER_EXCEPTION_RE.test(line.text)) {
      this.emit({ ...line, flutterError: true });
      return;
    }
    this.emit(line);
  }

  flush(): void {
    if (this.open) this.close();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close(), this.opts.idleMs);
    this.timer.unref?.();
  }

  private close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const group = this.open;
    this.open = undefined;
    if (group) this.emit({ text: group.lines.join('\n'), ts: group.ts, flutterError: true });
  }
}

export interface StdioPipelineOptions {
  stream: 'stdout' | 'stderr';
  /** Evaluated per line: the app may be recognized as Flutter only after attach. */
  isFlutter: () => boolean;
  emit: (log: AppLog) => void;
}

/** One stream's chunks → assembled, de-prefixed, error-grouped log entries. */
export class StdioPipeline {
  private readonly assembler: LineAssembler;
  private readonly grouper: FlutterErrorGrouper;

  constructor(private readonly opts: StdioPipelineOptions) {
    this.grouper = new FlutterErrorGrouper((line) => this.emitLine(line));
    this.assembler = new LineAssembler((line) => this.onLine(line));
  }

  push(chunk: string, ts: number): void {
    this.assembler.push(chunk, ts);
  }

  flush(): void {
    this.assembler.flush();
    this.grouper.flush();
  }

  private onLine(line: StdioLine): void {
    if (this.opts.isFlutter()) {
      const text = line.text.startsWith('flutter: ') ? line.text.slice('flutter: '.length) : line.text;
      this.grouper.push({ text, ts: line.ts });
    } else {
      this.emitLine(line);
    }
  }

  private emitLine(line: GroupedLine): void {
    if (!line.flutterError && line.text.trim() === '') return;
    const flutter = this.opts.isFlutter();
    const log: AppLog = {
      ts: line.ts,
      level: line.flutterError ? 'error' : this.opts.stream === 'stderr' ? 'error' : 'info',
      tag: flutter ? 'flutter' : this.opts.stream,
      message: line.text,
      kind: line.flutterError ? 'flutter-error' : 'text',
    };
    this.opts.emit(log);
  }
}
