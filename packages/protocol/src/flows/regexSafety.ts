/**
 * A cheap check for regular expressions that can take exponential time on a line that almost matches
 * ("catastrophic backtracking"): a repeated group that itself repeats something without bound, such as
 * `(a+)+`, `(\w+\s?)*$` or `(.*)*`. Flows run user patterns against every log line, so a pattern like that can
 * stall Dürbün; validation warns, and the server runs such patterns with a time limit.
 *
 * Deliberately simple: it finds the common shapes, not every slow pattern.
 */

/** True when the quantifier at `i` (`+`, `*`, `{n,}` or `{n,m}` with m > 1) repeats without a small bound. */
function quantifierAt(pattern: string, i: number): { length: number; unbounded: boolean } | undefined {
  const ch = pattern[i];
  if (ch === '+' || ch === '*') return { length: 1, unbounded: true };
  if (ch === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
    if (!m) return undefined;
    if (m[2] === undefined) return { length: m[0].length, unbounded: false };
    const max = m[3] === '' ? Infinity : Number(m[3]);
    return { length: m[0].length, unbounded: max > 1 };
  }
  return undefined;
}

/** Why the pattern may backtrack exponentially (a short English reason), or undefined. */
export function unsafeRegexReason(pattern: string): string | undefined {
  // One entry per open group: does it repeat something without bound inside?
  const groups: { start: number; repeats: boolean }[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++; // the escaped character; a quantifier after it is checked on the next turn
      const q = quantifierAt(pattern, i + 1);
      if (q?.unbounded && groups.length && !inClass) groups[groups.length - 1]!.repeats = true;
      continue;
    }
    if (inClass) {
      if (ch === ']') {
        inClass = false;
        const q = quantifierAt(pattern, i + 1);
        if (q?.unbounded && groups.length) groups[groups.length - 1]!.repeats = true;
      }
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      groups.push({ start: i, repeats: false });
      continue;
    }
    if (ch === ')') {
      const g = groups.pop();
      if (!g) continue;
      const q = quantifierAt(pattern, i + 1);
      if (q?.unbounded && g.repeats) return `the group "${pattern.slice(g.start, i + 1)}" repeats something that repeats itself`;
      // The group as a whole repeats inside its parent (or holds a repeat that the parent repeats again).
      if (groups.length && (g.repeats || q?.unbounded)) groups[groups.length - 1]!.repeats = true;
      continue;
    }
    const q = quantifierAt(pattern, i + 1);
    if (q?.unbounded && groups.length) groups[groups.length - 1]!.repeats = true;
  }
  return undefined;
}
