/**
 * What the app does when something goes wrong (no Electron import, so it is unit-tested): the
 * start-failure dialog keeps Retry and Quit reachable, and a UI renderer that keeps dying is not
 * reloaded forever.
 */

export type FailureChoice = 'retry' | 'log' | 'quit';

/**
 * The start-failure dialog: "Show diagnostic log" reveals the log and asks again, so the user is
 * never left on a dead window without a way to retry. Resolves 'cancelled' when quit was requested
 * while the dialog was open.
 */
export async function resolveFailure(ask: () => Promise<FailureChoice>, revealLog: () => void, quitting: () => boolean): Promise<'retry' | 'quit' | 'cancelled'> {
  for (;;) {
    const choice = await ask();
    if (quitting()) return 'cancelled';
    if (choice !== 'log') return choice;
    revealLog();
  }
}

/**
 * Automatic reloads after the UI's renderer process dies (crash, out of memory, killed): at most `max`
 * within `windowMs`. A renderer that keeps dying on the same data would otherwise reload every half
 * second and keep the CPU busy; past the limit the app asks the user instead.
 */
export function createReloadGuard(opts: { max?: number; windowMs?: number; now?: () => number } = {}): { allow(): boolean; reset(): void } {
  const max = opts.max ?? 3;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let exits: number[] = [];
  return {
    /** Records a renderer exit; true while an automatic reload is still allowed. */
    allow() {
      const t = now();
      exits = exits.filter((x) => t - x < windowMs);
      exits.push(t);
      return exits.length <= max;
    },
    reset() {
      exits = [];
    },
  };
}
