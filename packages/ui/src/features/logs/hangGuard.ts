/**
 * A search or highlight pattern that hangs the page (a regex with catastrophic backtracking meeting a long
 * line) must not hang it again after a reload: the pattern is persisted, so it would be applied at once.
 * Before a pattern is applied a mark is stored; a timer clears it once the page stayed responsive. A hung
 * page never runs that timer, so the next start finds the mark and drops the pattern instead.
 */
import { readStorage, removeStorage, writeStorage } from '../../lib/persist';

const MARK = 'logs.applying';
/** How long the page must keep running timers after applying a pattern. */
export const RESPONSIVE_MS = 2_000;

export type HangSource = 'query' | 'highlight';

let timer: ReturnType<typeof setTimeout> | undefined;

function marked(): HangSource[] {
  const v = readStorage<unknown>(MARK, []);
  return Array.isArray(v) ? v.filter((x): x is HangSource => x === 'query' || x === 'highlight') : [];
}

/** Call right before a search query or highlight rules are applied to the log list. */
export function markApplying(source: HangSource): void {
  const now = marked();
  if (!now.includes(source)) writeStorage(MARK, [...now, source]);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    removeStorage(MARK);
  }, RESPONSIVE_MS);
}

/**
 * At start, before the logs view reads its saved state: a mark left behind means the last run hung while
 * applying those patterns. The query is cleared; highlight rules that use a regex are turned off
 * (`disableRegexHighlights`). Returns what was reset (empty: nothing), for a notice.
 */
export function recoverFromHang(disableRegexHighlights: () => void): HangSource[] {
  const sources = marked();
  removeStorage(MARK);
  if (sources.includes('query')) writeStorage('logs.query', '');
  if (sources.includes('highlight')) disableRegexHighlights();
  return sources;
}
