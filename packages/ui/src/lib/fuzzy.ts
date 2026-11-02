/**
 * Fuzzy matching for the command palette and pickers.
 *
 * Case-insensitive subsequence match scored with a small dynamic program (fzy-like): matches at word
 * starts and consecutive runs score high, gaps cost a little, prefixes/substrings get a bonus.
 * Turkish letters are folded (ı/İ→i, ş→s, ğ→g, ç→c, ö→o, ü→u) so "sistem kontrolu" finds
 * "Sistem kontrolü". Folding is 1:1 per character, so returned indices point into the original text.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices of matched characters in the original text (ascending). */
  indices: number[];
}

const FOLD: Record<string, string> = {
  İ: 'i',
  I: 'i',
  ı: 'i',
  Ş: 's',
  ş: 's',
  Ğ: 'g',
  ğ: 'g',
  Ç: 'c',
  ç: 'c',
  Ö: 'o',
  ö: 'o',
  Ü: 'u',
  ü: 'u',
  Â: 'a',
  â: 'a',
  Î: 'i',
  î: 'i',
  Û: 'u',
  û: 'u',
};

/** Lower-cases and folds one character; always returns exactly one UTF-16 unit for BMP letters. */
export function foldChar(c: string): string {
  const mapped = FOLD[c];
  if (mapped) return mapped;
  const lower = c.toLowerCase();
  return lower.length === 1 ? lower : c;
}

/** Folds a whole string, preserving its length (index i of the result corresponds to index i of the input). */
export function fold(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) out += foldChar(s[i]!);
  return out;
}

const SEPARATORS = new Set([' ', '/', '\\', '-', '_', '.', ':', '›', '>', '(', ')', '[', ']', '·', ',', '@', '#']);

function isBoundary(text: string, j: number): boolean {
  if (j === 0) return true;
  const prev = text[j - 1]!;
  const cur = text[j]!;
  if (SEPARATORS.has(prev)) return true;
  const prevLower = prev !== prev.toUpperCase() && prev === prev.toLowerCase();
  const curUpper = cur !== cur.toLowerCase() && cur === cur.toUpperCase();
  if (prevLower && curUpper) return true;
  const prevDigit = prev >= '0' && prev <= '9';
  const curDigit = cur >= '0' && cur <= '9';
  return curDigit && !prevDigit;
}

const NEG = -1e9;
const SCORE_FIRST = 12;
const SCORE_BOUNDARY = 10;
const SCORE_MATCH = 1;
const SCORE_CONSECUTIVE = 8;
const GAP = 1;
const LEADING_GAP = 0.25;

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = fold(query.trim());
  if (q.length === 0) return { score: 0, indices: [] };
  const t = fold(text);
  const n = q.length;
  const m = t.length;
  if (n > m) return null;

  // Fast reject: must be a subsequence.
  let qi = 0;
  for (let j = 0; j < m && qi < n; j++) if (t[j] === q[qi]) qi++;
  if (qi < n) return null;

  const bonus = new Float64Array(m);
  for (let j = 0; j < m; j++) bonus[j] = j === 0 ? SCORE_FIRST : isBoundary(text, j) ? SCORE_BOUNDARY : SCORE_MATCH;

  const M: Float64Array[] = [];
  const back: Int32Array[] = [];
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(m).fill(NEG);
    const brow = new Int32Array(m).fill(-1);
    const prev = i > 0 ? M[i - 1]! : null;
    // Best gapped predecessor: max over k <= j-2 of prev[k] - GAP*(j-k-1).
    let run = NEG;
    let runIdx = -1;
    for (let j = 0; j < m; j++) {
      if (prev && j >= 2) {
        const decayed = run - GAP;
        const cand = prev[j - 2]! - GAP;
        if (cand >= decayed) {
          run = cand;
          runIdx = j - 2;
        } else {
          run = decayed;
        }
      }
      if (t[j] !== q[i]) continue;
      if (!prev) {
        row[j] = bonus[j]! - Math.min(j, 12) * LEADING_GAP;
        continue;
      }
      const consecutive = j > 0 && prev[j - 1]! > NEG / 2 ? prev[j - 1]! + Math.max(SCORE_CONSECUTIVE, bonus[j]!) : NEG;
      const gapped = run > NEG / 2 ? run + bonus[j]! : NEG;
      if (consecutive === NEG && gapped === NEG) continue;
      if (consecutive >= gapped) {
        row[j] = consecutive;
        brow[j] = j - 1;
      } else {
        row[j] = gapped;
        brow[j] = runIdx;
      }
    }
    M.push(row);
    back.push(brow);
  }

  const last = M[n - 1]!;
  let bestJ = -1;
  let best = NEG;
  for (let j = 0; j < m; j++) {
    if (last[j]! > best) {
      best = last[j]!;
      bestJ = j;
    }
  }
  if (bestJ < 0) return null;

  const indices = new Array<number>(n);
  let j = bestJ;
  for (let i = n - 1; i >= 0; i--) {
    indices[i] = j;
    j = back[i]![j]!;
  }

  let score = best - m * 0.02;
  if (t.startsWith(q)) score += 8;
  else if (t.includes(q)) score += 4;
  return { score, indices };
}

export interface FuzzyResult<T> extends FuzzyMatch {
  item: T;
  /** Which of the item's texts matched (0 = primary). */
  field: number;
}

/**
 * Filters and sorts items by fuzzy score. `getText` may return several texts (e.g. title + keywords);
 * secondary texts are weighted down. With an empty query, all items are returned in original order.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string | readonly string[],
  opts: { limit?: number } = {},
): FuzzyResult<T>[] {
  const limit = opts.limit ?? Infinity;
  if (!query.trim()) {
    return items.slice(0, limit === Infinity ? undefined : limit).map((item) => ({ item, score: 0, indices: [], field: 0 }));
  }
  const out: (FuzzyResult<T> & { order: number })[] = [];
  items.forEach((item, order) => {
    const texts = getText(item);
    const list = typeof texts === 'string' ? [texts] : texts;
    let best: FuzzyResult<T> | null = null;
    list.forEach((text, field) => {
      const m = fuzzyMatch(query, text);
      if (!m) return;
      const score = field === 0 ? m.score : m.score * 0.8 - 1;
      if (!best || score > best.score) best = { item, score, indices: field === 0 ? m.indices : [], field };
    });
    if (best) out.push({ ...(best as FuzzyResult<T>), order });
  });
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out.slice(0, limit).map(({ order: _order, ...rest }) => rest);
}
