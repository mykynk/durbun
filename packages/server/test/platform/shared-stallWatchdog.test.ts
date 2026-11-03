/**
 * StallWatchdog (shared/stallWatchdog.ts): a log stream that is never quiet when it works (idevicesyslog on a
 * busy iPhone) is restarted when it goes silent, with a backoff (a choked syslog relay is not helped by fast
 * restarts), and reports when lines flow again. Fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StallWatchdog, type StallInfo } from '../../src/platform/shared/stallWatchdog';

const STALL = 30_000;
const DELAYS = [2000, 5000, 15_000, 30_000];

describe('StallWatchdog', () => {
  let t0: number;
  beforeEach(() => {
    vi.useFakeTimers();
    t0 = Date.now();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A stream whose process the session stops on a stall and starts again on restart. */
  function stream(opts: { onStall?: (s: StallInfo) => void | Promise<void> } = {}) {
    const stalls: Array<StallInfo & { at: number }> = [];
    const restarts: number[] = [];
    const recoveries: Array<{ attempts: number; silentMs: number; at: number }> = [];
    const state = { attached: true, running: true };
    const w = new StallWatchdog({
      stallMs: STALL,
      restartDelaysMs: DELAYS,
      checkEveryMs: 1000,
      active: () => state.attached && state.running,
      onStall: (s) => {
        stalls.push({ ...s, at: Date.now() - t0 });
        state.running = false;
        return opts.onStall?.(s);
      },
      restart: () => {
        restarts.push(Date.now() - t0);
        state.running = true;
      },
      onRecovered: (r) => recoveries.push({ ...r, at: Date.now() - t0 }),
    });
    w.start();
    return { w, stalls, restarts, recoveries, state };
  }

  it('lines that keep coming are never a stall', async () => {
    const { w, stalls } = stream();
    for (let i = 0; i < 1200; i++) {
      w.seen();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(stalls).toEqual([]);
    w.stop();
  });

  it('silence while active is a stall; restarts follow the backoff (2 s, 5 s, 15 s, then every 30 s)', async () => {
    const { w, stalls, restarts } = stream();
    // The first check after start sets the baseline (t = 1 s); the stall is seen 30 s later.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(stalls).toEqual([{ attempt: 1, silentMs: 30_000, restartInMs: 2000, at: 31_000 }]);
    expect(w.stalled).toBe(true);
    await vi.advanceTimersByTimeAsync(1999);
    expect(restarts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(restarts).toEqual([33_000]);
    // Still silent after each restart (silence is measured from the next check after it).
    await vi.advanceTimersByTimeAsync(400_000);
    expect(stalls.slice(0, 6).map((s) => s.restartInMs)).toEqual([2000, 5000, 15_000, 30_000, 30_000, 30_000]);
    expect(stalls.map((s) => s.attempt)).toEqual(stalls.map((_, i) => i + 1));
    for (let i = 0; i < restarts.length; i++) expect(restarts[i]! - stalls[i]!.at).toBe(stalls[i]!.restartInMs);
    // Silence counts from the last line before the episode.
    expect(stalls[1]!.silentMs).toBe(stalls[1]!.at - 1000);
    w.stop();
  });

  it('the first line after a stall recovers once and resets the backoff', async () => {
    const { w, stalls, restarts, recoveries } = stream();
    await vi.advanceTimersByTimeAsync(31_000 + 2000 + 31_000 + 5000); // two stalls, two restarts
    expect(stalls).toHaveLength(2);
    expect(restarts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(500);
    w.seen();
    w.seen();
    expect(recoveries).toEqual([{ attempts: 2, silentMs: recoveries[0]!.at - 1000, at: recoveries[0]!.at }]);
    expect(w.stalled).toBe(false);
    // The next silence starts a new episode from the first delay.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(stalls).toHaveLength(3);
    expect(stalls[2]).toMatchObject({ attempt: 1, restartInMs: 2000 });
    // Seen half-way between two checks: found at the first check 30 s later.
    expect(stalls[2]!.silentMs).toBe(30_500);
    w.stop();
  });

  it('no stall while inactive (device away, process restarting); silence counts from when it is active again', async () => {
    const { w, stalls, state } = stream();
    state.attached = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(stalls).toEqual([]);
    state.attached = true;
    await vi.advanceTimersByTimeAsync(29_000);
    expect(stalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.silentMs).toBe(30_000);
    w.stop();
  });

  it('the stopped process\' last lines do not end the episode; the restart still comes', async () => {
    let finishStop!: () => void;
    const { w, restarts, recoveries } = stream({ onStall: () => new Promise<void>((r) => (finishStop = r)) });
    await vi.advanceTimersByTimeAsync(31_000);
    w.seen(); // flushed while the silent process is being killed
    finishStop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(recoveries).toEqual([]);
    expect(restarts).toEqual([33_000]);
    w.seen();
    expect(recoveries).toHaveLength(1);
    w.stop();
  });

  it('reset() ends an episode without a recovery and drops the pending restart; stop() ends everything', async () => {
    const a = stream();
    await vi.advanceTimersByTimeAsync(31_000);
    a.w.reset();
    a.state.running = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(a.restarts).toEqual([]);
    expect(a.recoveries).toEqual([]);
    expect(a.w.stalled).toBe(false);
    a.w.stop();

    const b = stream();
    await vi.advanceTimersByTimeAsync(31_000);
    b.w.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(b.restarts).toEqual([]);
    expect(b.stalls).toHaveLength(1);
  });

  it('stallMs 0 turns it off', async () => {
    const onStall = vi.fn();
    const w = new StallWatchdog({ stallMs: 0, restartDelaysMs: DELAYS, active: () => true, onStall, restart: vi.fn(), onRecovered: vi.fn() });
    w.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(onStall).not.toHaveBeenCalled();
    w.stop();
  });
});
