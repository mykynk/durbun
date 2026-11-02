import { describe, expect, it, vi } from 'vitest';
import { createReloadGuard, resolveFailure, type FailureChoice } from '../src/recovery';

describe('resolveFailure (start-failure dialog)', () => {
  const asker = (...answers: FailureChoice[]) => vi.fn(async () => answers.shift() ?? 'quit');

  it('"Show diagnostic log" reveals the log and asks again, so Retry stays reachable', async () => {
    const ask = asker('log', 'log', 'retry');
    const reveal = vi.fn();
    expect(await resolveFailure(ask, reveal, () => false)).toBe('retry');
    expect(reveal).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('quit and retry end the dialog', async () => {
    expect(await resolveFailure(asker('quit'), vi.fn(), () => false)).toBe('quit');
    expect(await resolveFailure(asker('retry'), vi.fn(), () => false)).toBe('retry');
  });

  it('a quit requested while the dialog was open wins', async () => {
    const reveal = vi.fn();
    expect(await resolveFailure(asker('log'), reveal, () => true)).toBe('cancelled');
    expect(reveal).not.toHaveBeenCalled();
  });
});

describe('createReloadGuard (renderer gone)', () => {
  it('allows a few reloads, then stops a crash loop', () => {
    let now = 0;
    const guard = createReloadGuard({ max: 3, windowMs: 60_000, now: () => now });
    const decisions = [0, 500, 1_000, 1_500].map((t) => ((now = t), guard.allow()));
    expect(decisions).toEqual([true, true, true, false]);
    guard.reset();
    expect(guard.allow()).toBe(true);
  });

  it('forgets crashes older than the window', () => {
    let now = 0;
    const guard = createReloadGuard({ max: 2, windowMs: 10_000, now: () => now });
    expect(guard.allow()).toBe(true);
    now = 1_000;
    expect(guard.allow()).toBe(true);
    now = 20_000;
    expect(guard.allow()).toBe(true);
  });
});
