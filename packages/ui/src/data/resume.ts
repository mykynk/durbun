import { logStore } from './logStore';

/**
 * Where this window's copy of the server data stands, so a reconnect continues it instead of loading everything
 * again (WS `/ui?epoch=…&afterLogId=…&netSeq=…`, protocol `UiResumed`). `epoch` comes from the snapshot (and
 * changes with every clear), `netSeq` from snapshots and batches, `afterLogId` is the newest line held. A server
 * that does not send an epoch (the dev mock, older servers) never gets a resume query and always sends everything.
 */
let epoch: string | undefined;
let netSeq: number | undefined;

export function noteEpoch(next: string | undefined): void {
  if (typeof next === 'string' && next) epoch = next;
}

export function noteNetSeq(next: number | undefined): void {
  if (typeof next === 'number' && Number.isSafeInteger(next) && next >= 0) netSeq = next;
}

/** The current resume point (undefined when the server never sent one). */
export function resumeEpoch(): string | undefined {
  return epoch;
}

/** Forget the resume point: the next connection loads everything (a full snapshot without an epoch). */
export function forgetResume(): void {
  epoch = undefined;
  netSeq = undefined;
}

/** Query to append to the WS URL ('' when there is nothing to continue). */
export function resumeQuery(): string {
  if (epoch === undefined || netSeq === undefined) return '';
  const p = new URLSearchParams({ epoch, afterLogId: String(logStore.lastId), netSeq: String(netSeq) });
  return `?${p.toString()}`;
}

/** `url` with the resume query (an existing query is kept). */
export function withResumeQuery(url: string): string {
  const q = resumeQuery();
  if (!q) return url;
  return url.includes('?') ? `${url}&${q.slice(1)}` : `${url}${q}`;
}
