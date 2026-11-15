/**
 * SDK-less reader state for `DeviceInfo.readers` (SPEC §10.8): 'ok' (an empty result is real), 'unavailable'
 * (tried and failed: tool missing, refused, an error) or 'unsupported' (impossible on this device / OS).
 * The hub merges `readers` per reader id, so drivers patch only the reader that changed.
 */
import type { DeviceInfo, DeviceReaderState } from '@durbun/protocol';

/**
 * How far back crash records are read when a device connects (Android dropbox, iOS .ips on devices and
 * simulators): a crash from Friday still shows when the phone is plugged in on Monday. The devices bound the
 * amount themselves (dropbox keeps a few days within a quota, iOS keeps a limited number of reports), and
 * each reader caps what one pass reads.
 */
export const CRASH_HISTORY_MS = 7 * 24 * 3600_000;

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

  /** Reading works; `code` + `detail` say how when it is not the usual way (a fallback tool). */
  ok(code?: string, detail?: string): void {
    const now = (this.opts.now ?? Date.now)();
    this.lastOkAt = now;
    const s = this.state;
    const same = s?.status === 'ok' && s.code === code && s.detail === detail;
    if (same && s.lastOk !== undefined && now - s.lastOk < (this.opts.refreshOkMs ?? 10 * 60_000)) return;
    this.set({ status: 'ok', ...(code ? { code } : {}), ...(detail ? { detail } : {}), lastOk: now });
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
