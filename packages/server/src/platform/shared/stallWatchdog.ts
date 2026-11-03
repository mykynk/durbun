import { every } from './timing';

/**
 * Silence watchdog for a log stream that is never quiet when it works (a busy iPhone sends hundreds of
 * idevicesyslog lines per second, an idle one still several per second). While `active()` (the device is
 * attached and the stream process runs), no `seen()` for `stallMs` is a stall: `onStall` is told (the session
 * stops the silent process and shows why) and `restart` runs after the next backoff delay (e.g. 2 s, 5 s,
 * 15 s, then every 30 s: a choked syslog relay is not helped by fast restarts). The next silence is measured
 * from the moment the stream is active again. The first `seen()` after a stall calls `onRecovered` and resets
 * the backoff.
 */
export interface StallWatchdogOptions {
  /** Silence that counts as a stall. */
  stallMs: number;
  /** Delay before each restart of one stall episode (the last one repeats). */
  restartDelaysMs: readonly number[];
  /** How often silence is checked (default: stallMs / 3, at most 5 s). */
  checkEveryMs?: number;
  /** Is the stream supposed to deliver lines right now? */
  active(): boolean;
  /** A stall (attempt 1 opens an episode); `silentMs` counts from the last line before the episode. */
  onStall(stall: StallInfo): void | Promise<void>;
  /** Start the stream again (after `restartInMs`). */
  restart(): void;
  /** Lines flow again after a stall. */
  onRecovered(recovery: { attempts: number; silentMs: number }): void;
  now?: () => number;
}

export interface StallInfo {
  attempt: number;
  silentMs: number;
  restartInMs: number;
}

export class StallWatchdog {
  private readonly now: () => number;
  private lastSeenAt: number;
  private wasActive = false;
  private attempt = 0;
  /** Time of the last line before the current stall episode (undefined: not stalled). */
  private stalledSince?: number;
  private restartTimer?: NodeJS.Timeout;
  private stallPending = false;
  private stopTicker?: () => void;
  private stopped = false;

  constructor(private readonly opts: StallWatchdogOptions) {
    this.now = opts.now ?? Date.now;
    this.lastSeenAt = this.now();
  }

  /** In a stall episode (lines stopped, restarts going on). */
  get stalled(): boolean {
    return this.stalledSince !== undefined;
  }

  start(): void {
    if (this.stopTicker || this.stopped || !(this.opts.stallMs > 0)) return;
    const every_ = this.opts.checkEveryMs ?? Math.max(20, Math.min(5000, Math.floor(this.opts.stallMs / 3)));
    this.stopTicker = every(every_, () => this.check());
  }

  stop(): void {
    this.stopped = true;
    this.stopTicker?.();
    this.stopTicker = undefined;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }

  /** A line arrived (called per line: cheap). */
  seen(): void {
    this.lastSeenAt = this.now();
    // Last lines of the process being stopped for the restart do not end the episode: the restart follows.
    if (this.stalledSince === undefined || this.stallPending) return;
    const recovery = { attempts: this.attempt, silentMs: this.lastSeenAt - this.stalledSince };
    this.endEpisode();
    if (!this.stopped) this.opts.onRecovered(recovery);
  }

  /** Forget a stall episode and measure silence from now (the stream was restarted on purpose). */
  reset(): void {
    this.endEpisode();
    this.lastSeenAt = this.now();
    this.wasActive = false;
  }

  /** One silence check (public for tests). */
  check(): void {
    if (this.stopped || this.restartTimer || this.stallPending) return;
    const now = this.now();
    if (!this.opts.active()) {
      this.wasActive = false;
      return;
    }
    if (!this.wasActive) {
      // Just (re)started, or the device is back: silence counts from now.
      this.wasActive = true;
      this.lastSeenAt = now;
      return;
    }
    if (now - this.lastSeenAt < this.opts.stallMs) return;
    this.attempt += 1;
    if (this.stalledSince === undefined) this.stalledSince = this.lastSeenAt;
    const delays = this.opts.restartDelaysMs;
    const restartInMs = delays.length ? delays[Math.min(this.attempt - 1, delays.length - 1)]! : this.opts.stallMs;
    const stall: StallInfo = { attempt: this.attempt, silentMs: now - this.stalledSince, restartInMs };
    this.stallPending = true;
    void Promise.resolve()
      .then(() => this.opts.onStall(stall))
      .catch(() => undefined)
      .finally(() => {
        this.stallPending = false;
        if (this.stopped || this.stalledSince === undefined) return;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = undefined;
          if (this.stopped || this.stalledSince === undefined) return;
          this.wasActive = false;
          this.opts.restart();
        }, restartInMs);
        this.restartTimer.unref?.();
      });
  }

  private endEpisode(): void {
    this.stalledSince = undefined;
    this.attempt = 0;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
  }
}
