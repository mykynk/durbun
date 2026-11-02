/**
 * Base for high-frequency stores that live OUTSIDE React state.
 *
 * Mutations call `changed()`; subscribers are notified and `version` is bumped AT MOST ONCE PER
 * ANIMATION FRAME. When requestAnimationFrame is unavailable (tests, some webviews) or the page is
 * hidden (rAF paused), a timer fallback is used so the version still advances.
 */

export interface FrameScheduler {
  /** Request one callback on the next frame (no-op when already pending). */
  schedule(): void;
  /** Run the pending callback synchronously (if any). */
  flush(): void;
  cancel(): void;
  readonly pending: boolean;
}

export interface FrameSchedulerOptions {
  /** Safety-net delay when rAF is available but may be throttled (ms). */
  rafFallbackMs?: number;
  /** Delay when rAF is unavailable (ms). */
  timerMs?: number;
  /** Delay while the document is hidden (ms). */
  hiddenMs?: number;
}

export function createFrameScheduler(callback: () => void, opts: FrameSchedulerOptions = {}): FrameScheduler {
  const rafFallbackMs = opts.rafFallbackMs ?? 120;
  const timerMs = opts.timerMs ?? 16;
  const hiddenMs = opts.hiddenMs ?? 250;
  let pending = false;
  let rafId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    if (timerId !== null) clearTimeout(timerId);
    rafId = null;
    timerId = null;
  };

  const run = () => {
    if (!pending) return;
    pending = false;
    clear();
    callback();
  };

  return {
    schedule() {
      if (pending) return;
      pending = true;
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      const hasRaf = typeof requestAnimationFrame === 'function';
      if (hasRaf && !hidden) {
        rafId = requestAnimationFrame(run);
        timerId = setTimeout(run, rafFallbackMs);
      } else {
        timerId = setTimeout(run, hidden ? hiddenMs : timerMs);
      }
    },
    flush: run,
    cancel() {
      pending = false;
      clear();
    },
    get pending() {
      return pending;
    },
  };
}

export interface VersionedSource {
  readonly version: number;
  subscribe(listener: () => void): () => void;
}

export abstract class VersionedStore implements VersionedSource {
  /** Bumped at most once per animation frame after a change. */
  version = 0;
  private readonly listeners = new Set<() => void>();
  private readonly scheduler = createFrameScheduler(() => {
    this.version++;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (err) {
        console.error('[durbun] store listener failed', err);
      }
    }
  });

  /** Mark the store as changed; listeners run on the next frame. */
  protected changed(): void {
    this.scheduler.schedule();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Deliver a pending change notification immediately (tests, or before a synchronous read). */
  flush(): void {
    this.scheduler.flush();
  }

  /** True when a change notification is waiting for the next frame. */
  get dirty(): boolean {
    return this.scheduler.pending;
  }
}
