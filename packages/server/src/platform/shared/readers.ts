/**
 * SDK-less reader state for `DeviceInfo.readers` (SPEC §10.8): 'ok' (an empty result is real), 'unavailable'
 * (tried and failed: tool missing, refused, an error) or 'unsupported' (impossible on this device / OS).
 * The hub merges `readers` per reader id, so drivers patch only the reader that changed.
 */
import type { DeviceInfo, DeviceReaderState } from '@durbun/protocol';

/** Per-reader-id merge (what the hub does on upsertDevice / patchDevice). */
export function mergeReaders(prev: DeviceInfo['readers'], patch: DeviceInfo['readers']): DeviceInfo['readers'] {
  return patch ? { ...prev, ...patch } : prev;
}

/** First line of an error text, short enough for a UI fallback ("detail"). */
export function readerDetail(text: string, max = 300): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface ReaderReporterOptions {
  /** While reading keeps working, refresh `lastOk` at most this often (default 10 min). */
  refreshOkMs?: number;
  now?: () => number;
}

/**
 * One reader of one device. Emits only real changes (status / code / detail) plus a `lastOk` refresh at most
 * every `refreshOkMs`, so a poll every few seconds does not turn into a device update every few seconds.
 */
export class ReaderReporter {
  private state?: DeviceReaderState;
  private lastOkAt?: number;

  constructor(
    private readonly emit: (state: DeviceReaderState) => void,
    private readonly opts: ReaderReporterOptions = {},
  ) {}

  get current(): DeviceReaderState | undefined {
    return this.state;
  }

  ok(): void {
    const now = (this.opts.now ?? Date.now)();
    this.lastOkAt = now;
    const s = this.state;
    if (s?.status === 'ok' && s.lastOk !== undefined && now - s.lastOk < (this.opts.refreshOkMs ?? 10 * 60_000)) return;
    this.set({ status: 'ok', lastOk: now });
  }

  unavailable(code: string, detail: string): void {
    this.change({ status: 'unavailable', code, detail });
  }

  unsupported(code: string, detail: string): void {
    this.change({ status: 'unsupported', code, detail });
  }

  private change(next: DeviceReaderState): void {
    const s = this.state;
    if (s && s.status === next.status && s.code === next.code && s.detail === next.detail) return;
    this.set({ ...next, ...(this.lastOkAt !== undefined ? { lastOk: this.lastOkAt } : {}) });
  }

  private set(state: DeviceReaderState): void {
    this.state = state;
    this.emit({ ...state });
  }
}
