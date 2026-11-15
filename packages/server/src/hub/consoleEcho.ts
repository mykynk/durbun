/**
 * React Native apps print each console line twice on Android: the Dürbün SDK sends it, and logcat carries it
 * with the tag `ReactNativeJS`. Where both streams meet, the logcat copy of a line the SDK also sent is
 * hidden — only while an SDK session of that process is live and has sent console lines lately, and only
 * for a logcat line whose text matches an SDK line (so nothing the SDK did not send is ever lost).
 *
 * Arrival order varies (logcat is often faster than the SDK's batches): an SDK line first leaves a key that
 * the logcat copy consumes; a logcat line first is held for a moment (HOLD_MS) and dropped if the SDK copy
 * arrives, otherwise released unchanged. Held lines are released at once when the session ends. Lines of
 * other tags, other processes, or apps without a live React Native session pass straight through.
 * Bounded: per session at most MAX_KEYS remembered SDK lines and MAX_HELD held logcat lines.
 */
import type { DeviceLogInput } from '../types';

export const RN_CONSOLE_TAG = 'ReactNativeJS';
/** How long a logcat line waits for its SDK copy. */
export const HOLD_MS = 1_500;
/** An SDK line waits this long for its logcat copy. */
const KEY_TTL_MS = 10_000;
/** The session counts as "sending console lines" for this long after its last one. */
export const ACTIVE_MS = 30_000;
const MAX_KEYS = 512;
const MAX_HELD = 2_000;

interface Held {
  deviceId: string;
  input: DeviceLogInput;
  key: string;
  until: number;
}

interface SessionState {
  lastSdkAt: number;
  keys: Array<{ key: string; at: number }>;
  held: Held[];
}

/** Whitespace-insensitive comparison key of a console line (first 300 characters). */
export function consoleKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export interface ConsoleEchoOptions {
  /** The live React Native SDK session (app id) that owns this process on the device, if any. */
  sessionFor(deviceId: string, pid: number): string | undefined;
  /** Append lines that waited and found no SDK copy (normal device-log path, in their original order). */
  release(deviceId: string, inputs: DeviceLogInput[]): void;
  now?: () => number;
}

export class ConsoleEchoFilter {
  private readonly sessions = new Map<string, SessionState>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: ConsoleEchoOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** An SDK log line of a React Native session (its text and tag as received). */
  noteSdkLine(appId: string, message: string, tag: string | undefined): void {
    const now = this.now();
    let s = this.sessions.get(appId);
    if (!s) {
      s = { lastSdkAt: now, keys: [], held: [] };
      this.sessions.set(appId, s);
    }
    s.lastSdkAt = now;
    const plain = consoleKey(message);
    // The SDK lifts a "[Tag] " prefix into the tag; logcat still has it in the text.
    const tagged = tag && tag !== 'console' ? consoleKey(`[${tag}] ${message}`) : undefined;
    const i = s.held.findIndex((h) => h.key === plain || (tagged !== undefined && h.key === tagged));
    if (i >= 0) {
      s.held.splice(i, 1); // the logcat copy came first: it is dropped
      return;
    }
    s.keys.push({ key: plain, at: now });
    if (tagged) s.keys.push({ key: tagged, at: now });
    this.prune(s, now);
  }

  /**
   * Device lines about to be stored: returns those to append now; logcat copies of SDK lines are dropped
   * and `ReactNativeJS` lines of an active session wait (see the module comment).
   */
  filter(deviceId: string, inputs: DeviceLogInput[]): DeviceLogInput[] {
    if (this.sessions.size === 0) return inputs;
    const now = this.now();
    let out: DeviceLogInput[] | undefined;
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!;
      const pass = this.take(deviceId, input, now);
      if (pass && !out) continue;
      if (!out) out = inputs.slice(0, i);
      if (pass) out.push(input);
    }
    return out ?? inputs;
  }

  /** The session ended: lines still waiting for it are appended now. */
  sessionEnded(appId: string): void {
    const s = this.sessions.get(appId);
    if (!s) return;
    this.sessions.delete(appId);
    this.releaseHeld(s.held);
    this.schedule();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.sessions.clear();
  }

  /** true: append now; false: dropped or held. */
  private take(deviceId: string, input: DeviceLogInput, now: number): boolean {
    if (input.tag !== RN_CONSOLE_TAG || typeof input.pid !== 'number') return true;
    const appId = this.opts.sessionFor(deviceId, input.pid);
    const s = appId ? this.sessions.get(appId) : undefined;
    if (!s || now - s.lastSdkAt > ACTIVE_MS) return true;
    const key = consoleKey(typeof input.message === 'string' ? input.message : String(input.message ?? ''));
    const k = s.keys.findIndex((e) => e.key === key && now - e.at <= KEY_TTL_MS);
    if (k >= 0) {
      s.keys.splice(k, 1); // the SDK copy came first
      return false;
    }
    if (s.held.length >= MAX_HELD) this.releaseHeld(s.held.splice(0, s.held.length - MAX_HELD + 1));
    s.held.push({ deviceId, input, key, until: now + HOLD_MS });
    this.schedule();
    return false;
  }

  private prune(s: SessionState, now: number): void {
    while (s.keys.length > 0 && (s.keys.length > MAX_KEYS || now - s.keys[0]!.at > KEY_TTL_MS)) s.keys.shift();
  }

  private releaseHeld(held: Held[]): void {
    if (held.length === 0) return;
    // Consecutive lines of one device go out in one batch, in their original order.
    let batch: DeviceLogInput[] = [];
    let device = held[0]!.deviceId;
    for (const h of held) {
      if (h.deviceId !== device) {
        this.opts.release(device, batch);
        batch = [];
        device = h.deviceId;
      }
      batch.push(h.input);
    }
    this.opts.release(device, batch);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let next = Number.POSITIVE_INFINITY;
    for (const s of this.sessions.values()) if (s.held.length > 0) next = Math.min(next, s.held[0]!.until);
    if (next === Number.POSITIVE_INFINITY) return;
    this.timer = setTimeout(() => this.expire(), Math.max(0, next - this.now()));
    this.timer.unref?.();
  }

  private expire(): void {
    this.timer = undefined;
    const now = this.now();
    for (const [appId, s] of this.sessions) {
      let n = 0;
      while (n < s.held.length && s.held[n]!.until <= now) n++;
      if (n > 0) this.releaseHeld(s.held.splice(0, n));
      this.prune(s, now);
      if (s.held.length === 0 && s.keys.length === 0 && now - s.lastSdkAt > ACTIVE_MS) this.sessions.delete(appId);
    }
    this.schedule();
  }
}
