/**
 * SDK-less reader states of one device (`DeviceInfo.readers`, SPEC §10.3 / §10.4), so the UI can tell
 * "nothing found" from "cannot read". A reader is sent when its status or code changes, and again at most
 * every 5 min while it stays the same (fresh `lastOk`, current `detail`). Each patch carries only the
 * reader that changed: the hub merges per reader id.
 */
import type { DeviceReaderId, DeviceReaderState } from '@durbun/protocol';

export const READER_REFRESH_MS = 5 * 60_000;

/** Codes this driver sends (`reader.<readerId>.<reason>`). */
export const READER_CODES = {
  dropboxRefused: 'reader.crashReports.dropboxRefused',
  crashReportsFailed: 'reader.crashReports.failed',
  frameStatsNoData: 'reader.frameStats.noData',
} as const;

export type ReaderReport = { status: 'ok' } | { status: 'unavailable' | 'unsupported'; code: string; detail?: string };

export class DeviceReaders {
  private readonly sent = new Map<DeviceReaderId, { state: DeviceReaderState; at: number }>();
  private readonly lastOk = new Map<DeviceReaderId, number>();

  constructor(
    private readonly send: (id: DeviceReaderId, state: DeviceReaderState) => void,
    private readonly now: () => number = Date.now,
  ) {}

  report(id: DeviceReaderId, r: ReaderReport): void {
    const now = this.now();
    if (r.status === 'ok') this.lastOk.set(id, now);
    const prev = this.sent.get(id);
    const code = r.status === 'ok' ? undefined : r.code;
    if (prev && prev.state.status === r.status && prev.state.code === code && now - prev.at < READER_REFRESH_MS) return;
    const state: DeviceReaderState = { status: r.status };
    if (r.status !== 'ok') {
      state.code = r.code;
      if (r.detail) state.detail = r.detail;
    }
    const ok = this.lastOk.get(id);
    if (ok !== undefined) state.lastOk = ok;
    this.sent.set(id, { state, at: now });
    this.send(id, state);
  }

  /** Last state sent for `id` (tests / diagnostics). */
  get(id: DeviceReaderId): DeviceReaderState | undefined {
    return this.sent.get(id)?.state;
  }
}
