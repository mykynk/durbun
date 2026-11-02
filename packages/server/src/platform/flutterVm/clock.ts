/**
 * Device clock estimate. Wire timestamps use the device clock (like logcat/syslog), but metrics and
 * synthesized lines are produced on the desktop. Every live VM event carries the device's `timestamp`
 * (ms); `deviceTs - receivedAt` = offset − delivery latency, so the maximum over a recent window is the
 * best offset estimate. Historical (replayed) events must not be observed.
 */
export class DeviceClock {
  private samples: { at: number; offset: number }[] = [];

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  observe(deviceMs: unknown): void {
    if (typeof deviceMs !== 'number' || !Number.isFinite(deviceMs) || deviceMs <= 0) return;
    const at = this.now();
    this.samples.push({ at, offset: deviceMs - at });
    if (this.samples.length > 256 || at - this.samples[0]!.at > this.windowMs) {
      this.samples = this.samples.filter((s) => at - s.at <= this.windowMs).slice(-256);
    }
  }

  /** device − desktop (ms); 0 until something was observed, then the last estimate while idle. */
  offset(): number {
    const at = this.now();
    let best: number | undefined;
    for (const s of this.samples) {
      if (at - s.at > this.windowMs) continue;
      if (best === undefined || s.offset > best) best = s.offset;
    }
    if (best !== undefined) this.last = best;
    return this.last;
  }

  private last = 0;

  deviceNow(): number {
    return this.now() + this.offset();
  }
}
