/**
 * What the server tells the user about an SDK session beyond its data: messages it had to drop (too large,
 * invalid, of a type it does not know), a protocol version it does not fully understand, and a device clock
 * that is far off the Mac clock. Each becomes a system line with a `code` + `params` and an English
 * `message` fallback; drops are rate-limited per session and reason.
 */
import { MAX_FRAME_BYTES, PROTOCOL_VERSION } from '@durbun/protocol';
import type { AppSession } from '@durbun/protocol';
import type { NetTooLargeInput, SystemLogInput } from '../types';

/** Oldest SDK wire protocol this server still reads completely. */
export const MIN_SDK_PROTOCOL = 1;

/** Message types this server knows (a valid-looking message of another type comes from a newer SDK). */
export const KNOWN_SDK_TYPES: ReadonlySet<string> = new Set([
  'hello',
  'log',
  'net.request',
  'net.response',
  'net.error',
  'net.ws',
  'net.sse',
  'event',
  'metric',
  'command.result',
  'actions',
  'pong',
]);

/** Bytes kept from the start of an oversized frame to read its type, id and a few fields. */
export const OVERSIZE_HEAD_BYTES = 8 * 1024;

export type DropReason = 'tooLarge' | 'invalid' | 'unknownType';

const DROP_CODES: Record<DropReason, string> = {
  tooLarge: 'app.messageTooLarge',
  invalid: 'app.messageInvalid',
  unknownType: 'app.messageUnknown',
};

/** At most one line per session and reason within this window; later drops are counted into the next line. */
export const DROP_LINE_INTERVAL_MS = 60_000;

const mb = (n: number) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
/** A message type for display: bounded and printable (it comes from the wire). */
export const safeType = (t: unknown): string => (typeof t === 'string' ? t.replace(/[^\w.:-]/g, '').slice(0, 64) : '') || '?';

/* ───────────── reading the start of an oversized frame ───────────── */

export interface FrameHead {
  type?: string;
  id?: string;
  ts?: number;
  method?: string;
  url?: string;
  status?: number;
}

function stringField(head: string, key: string, max: number): string | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){0,${max}})"`).exec(head);
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return undefined;
  }
}

function numberField(head: string, key: string): number | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`).exec(head);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Best-effort fields from the first bytes of a frame that was too large to parse. SDKs write `type`, `id`
 * and `ts` first and bodies last, so these are usually in the head; anything not found stays undefined.
 * Only top-level-looking keys are searched; a nested key with the same name could be picked up, which is
 * acceptable for a diagnostic (the type must still be a known network message for anything to change).
 */
export function readFrameHead(head: Buffer | string | undefined): FrameHead {
  if (head === undefined) return {};
  const text = (typeof head === 'string' ? head : head.toString('utf8')).slice(0, OVERSIZE_HEAD_BYTES);
  const out: FrameHead = {};
  const type = stringField(text, 'type', 64);
  if (type) out.type = type;
  const id = stringField(text, 'id', 512) ?? (numberField(text, 'id') !== undefined ? String(numberField(text, 'id')) : undefined);
  if (id) out.id = id;
  const ts = numberField(text, 'ts');
  if (ts !== undefined) out.ts = ts;
  const method = stringField(text, 'method', 32);
  if (method) out.method = method;
  const url = stringField(text, 'url', 4096);
  if (url) out.url = url;
  const status = numberField(text, 'status');
  if (status !== undefined && status >= 0 && status < 1000) out.status = Math.floor(status);
  return out;
}

/** Network message types whose oversize drop changes a request's state (Hub.netTooLarge). */
export function netTooLargeInput(head: FrameHead, bytes: number, limit = MAX_FRAME_BYTES): NetTooLargeInput | undefined {
  if (!head.id) return undefined;
  const base = { id: head.id, bytes, limit, ...(head.ts !== undefined ? { ts: head.ts } : {}) };
  if (head.type === 'net.request') {
    return { ...base, part: 'request', ...(head.method ? { method: head.method } : {}), ...(head.url ? { url: head.url } : {}) };
  }
  if (head.type === 'net.response' || head.type === 'net.error') {
    return { ...base, part: 'response', ...(head.status !== undefined ? { status: head.status } : {}) };
  }
  return undefined;
}

/* ───────────── dropped messages ───────────── */

interface DropState {
  lastLineAt: number;
  /** Drops since the last line (not yet reported). */
  pending: number;
}

/**
 * Per-session rate limit for drop lines: the first drop of a reason writes a line at once; further drops of
 * that reason within DROP_LINE_INTERVAL_MS are counted and reported with the next line after the window.
 * Bounded: one small record per reason.
 */
export class DropReporter {
  private readonly state = new Map<DropReason, DropState>();

  constructor(
    private readonly emit: (line: SystemLogInput) => void,
    private readonly now: () => number = Date.now,
  ) {}

  drop(reason: DropReason, app: Pick<AppSession, 'id' | 'app'>, details: { type?: string; bytes?: number }): void {
    const now = this.now();
    let s = this.state.get(reason);
    if (!s) {
      s = { lastLineAt: Number.NEGATIVE_INFINITY, pending: 0 };
      this.state.set(reason, s);
    }
    s.pending++;
    if (now - s.lastLineAt < DROP_LINE_INTERVAL_MS) return;
    const count = s.pending;
    s.pending = 0;
    s.lastLineAt = now;
    this.emit(dropLine(reason, app, { ...details, count }));
  }
}

export function dropLine(
  reason: DropReason,
  session: Pick<AppSession, 'id' | 'app'>,
  details: { type?: string; bytes?: number; count: number },
): SystemLogInput {
  const name = session.app.name;
  const type = safeType(details.type);
  const more = details.count > 1 ? ` (${details.count} messages since the last note)` : '';
  const params: Record<string, string | number> = { app: name, bundleId: session.app.id, type, count: details.count };
  let message: string;
  if (reason === 'tooLarge') {
    // bytes 0 = size unknown (the WebSocket server refused the frame before it was read).
    const bytes = Math.max(0, Math.floor(details.bytes ?? 0));
    params.bytes = bytes;
    params.limit = MAX_FRAME_BYTES;
    const what = bytes > 0 ? `a ${mb(bytes)} "${type}" message` : 'a message';
    message = `Dürbün dropped ${what} from ${name}: it is over the ${mb(MAX_FRAME_BYTES)} message limit${more}`;
  } else if (reason === 'invalid') {
    message = `Dürbün dropped an unreadable "${type}" message from ${name}: required fields are missing or have the wrong type${more}`;
  } else {
    message = `Dürbün does not know the "${type}" messages ${name} sends and skipped them: its SDK is newer than this Dürbün; update Dürbün${more}`;
  }
  return { message, level: 'warn', code: DROP_CODES[reason], params, appId: session.id };
}

/* ───────────── protocol version ───────────── */

export function protocolMismatch(sdkProtocol: number | undefined): AppSession['protocolMismatch'] {
  if (sdkProtocol === undefined) return undefined;
  if (sdkProtocol > PROTOCOL_VERSION) return 'sdk-newer';
  if (sdkProtocol < MIN_SDK_PROTOCOL) return 'sdk-older';
  return undefined;
}

export function protocolLine(session: Pick<AppSession, 'id' | 'app' | 'sdk'>, sdkProtocol: number, mismatch: 'sdk-newer' | 'sdk-older'): SystemLogInput {
  const name = session.app.name;
  const sdk = `${session.sdk.name} ${session.sdk.version}`;
  const params = {
    app: name,
    bundleId: session.app.id,
    sdk: session.sdk.name,
    sdkVersion: session.sdk.version,
    protocol: sdkProtocol,
    serverProtocol: PROTOCOL_VERSION,
    minProtocol: MIN_SDK_PROTOCOL,
  };
  if (mismatch === 'sdk-newer') {
    return {
      message: `${name} uses ${sdk} (protocol ${sdkProtocol}), newer than this Dürbün understands (protocol ${PROTOCOL_VERSION}): some data may be missing. Update Dürbün.`,
      level: 'warn',
      code: 'app.sdkNewer',
      params,
      appId: session.id,
    };
  }
  return {
    message: `${name} uses ${sdk} (protocol ${sdkProtocol}), older than this Dürbün supports (protocol ${MIN_SDK_PROTOCOL} or later): some data may be missing. Update the Dürbün SDK in the app.`,
    level: 'warn',
    code: 'app.sdkOlder',
    params,
    appId: session.id,
  };
}

/* ───────────── device clock ───────────── */

/**
 * A device clock this far off the Mac clock gets a line. Below a few seconds, device log times still read
 * correctly next to Mac-clock rows (flow steps, markers, resends) and tolerance for the measurement (half
 * the round trip, usually well under a second over USB or Wi-Fi) stays out of the decision; above it, a
 * "last 5 minutes" filter or a timeline that mixes both clocks starts to mislead.
 */
export const CLOCK_SKEW_LINE_MS = 5_000;
/** Samples with a longer round trip say too little about the clock (queued pong, busy link). */
export const CLOCK_SAMPLE_MAX_RTT_MS = 2_000;
/** A new estimate is published to the UI only when it moved at least this much. */
const CLOCK_PUBLISH_STEP_MS = 250;

export interface ClockEstimate {
  offsetMs: number;
  accuracyMs: number;
}

/**
 * NTP-style estimate from ping/pong: every SDK answers a ping with a pong carrying its own clock. With the
 * ping sent at t0 and the pong received at t1, the device read its clock somewhere in between, so
 * offset = (t0 + t1) / 2 - pong.ts, give or take (t1 - t0) / 2. The sample with the shortest round trip
 * wins. Approximate by nature: a pong that waited in the SDK's send queue widens the uncertainty. A pong is
 * paired with the latest ping only (SDKs may drop a pong while their queue is full), and a line needs two
 * samples that agree, so one late pong cannot raise a false alarm.
 */
export class ClockSkewEstimator {
  private lastPingAt: number | undefined;
  private best: ClockEstimate | undefined;
  private published: ClockEstimate | undefined;
  private beyond = 0;
  private reported = false;

  pingSent(at: number): void {
    this.lastPingAt = at;
  }

  /**
   * A pong arrived at `receivedAt` carrying device time `deviceTs`. Returns the estimate to publish when it
   * changed noticeably, otherwise undefined.
   */
  pong(deviceTs: number, receivedAt: number): ClockEstimate | undefined {
    const sentAt = this.lastPingAt;
    this.lastPingAt = undefined;
    if (sentAt === undefined || !Number.isFinite(deviceTs)) return undefined;
    const rtt = receivedAt - sentAt;
    if (rtt < 0 || rtt > CLOCK_SAMPLE_MAX_RTT_MS) return undefined;
    const sample: ClockEstimate = { offsetMs: Math.round((sentAt + receivedAt) / 2 - deviceTs), accuracyMs: Math.max(1, Math.round(rtt / 2)) };
    this.beyond = Math.abs(sample.offsetMs) - sample.accuracyMs >= CLOCK_SKEW_LINE_MS ? this.beyond + 1 : 0;
    if (this.best && this.best.accuracyMs <= sample.accuracyMs) {
      // A less precise sample replaces the best one only when they disagree (the device clock was changed).
      if (Math.abs(sample.offsetMs - this.best.offsetMs) <= sample.accuracyMs + this.best.accuracyMs + CLOCK_PUBLISH_STEP_MS) return undefined;
    }
    this.best = sample;
    const prev = this.published;
    if (prev && Math.abs(prev.offsetMs - sample.offsetMs) < CLOCK_PUBLISH_STEP_MS && Math.abs(prev.accuracyMs - sample.accuracyMs) < CLOCK_PUBLISH_STEP_MS) {
      return undefined;
    }
    this.published = sample;
    return sample;
  }

  /** The current best estimate, if any. */
  get estimate(): ClockEstimate | undefined {
    return this.best;
  }

  /** The line was already written for this app launch (an earlier connection of the same session). */
  markReported(): void {
    this.reported = true;
  }

  /** True once per session: two samples in a row put the device clock beyond CLOCK_SKEW_LINE_MS. */
  shouldReport(): boolean {
    if (this.reported || this.beyond < 2 || !this.best) return false;
    if (Math.abs(this.best.offsetMs) - this.best.accuracyMs < CLOCK_SKEW_LINE_MS) return false;
    this.reported = true;
    return true;
  }
}

export function clockSkewLine(session: Pick<AppSession, 'id' | 'app'>, estimate: ClockEstimate, deviceName: string): SystemLogInput {
  const seconds = Math.round(Math.abs(estimate.offsetMs) / 1000);
  const behind = estimate.offsetMs > 0;
  const name = session.app.name;
  return {
    message: `The clock of ${deviceName} is about ${seconds} s ${behind ? 'behind' : 'ahead of'} the Mac (measured while ${name} was connected, ±${Math.max(1, Math.round(estimate.accuracyMs / 100) / 10)} s). Times of its log lines are shown as the device reports them.`,
    level: 'warn',
    code: behind ? 'app.clockBehind' : 'app.clockAhead',
    params: { app: name, bundleId: session.app.id, device: deviceName, seconds, offsetMs: estimate.offsetMs, accuracyMs: estimate.accuracyMs },
    appId: session.id,
  };
}
