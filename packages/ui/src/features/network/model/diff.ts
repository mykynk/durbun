/**
 * Line diff for comparing two requests/responses.
 *
 * LCS (longest common subsequence) with three refinements so big bodies stay fast:
 *  1. common prefix/suffix are matched first (typical API responses differ in a few lines);
 *  2. the remaining middle is solved with a dynamic-programming LCS when it fits a cell budget;
 *  3. larger middles are split at "patience" anchors (lines unique in both sides, in increasing order)
 *     and each piece is diffed recursively; whatever still does not fit is shown as a block
 *     replacement and the result is flagged `approximate`.
 * Inputs longer than `maxLines` are cut (flag `truncated`).
 */

export type DiffOpType = 'equal' | 'remove' | 'add';

export interface DiffOp {
  type: DiffOpType;
  text: string;
  /** 0-based line index in A (equal/remove). */
  a?: number;
  /** 0-based line index in B (equal/add). */
  b?: number;
}

export interface DiffResult {
  ops: DiffOp[];
  /** Part of the input was diffed coarsely (block replacement) because it was too large. */
  approximate: boolean;
  /** A or B had more lines than `maxLines`; only the first `maxLines` were compared. */
  truncated: boolean;
  added: number;
  removed: number;
  equal: number;
}

export interface DiffOptions {
  /** Lines per side (default 20 000). */
  maxLines?: number;
  /** DP table budget in cells (default 4 000 000 ≈ 8 MB). */
  maxCells?: number;
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function diffLines(aIn: readonly string[], bIn: readonly string[], opts: DiffOptions = {}): DiffResult {
  const maxLines = opts.maxLines ?? 20_000;
  const maxCells = opts.maxCells ?? 4_000_000;
  const truncated = aIn.length > maxLines || bIn.length > maxLines;
  const aLines = aIn.length > maxLines ? aIn.slice(0, maxLines) : aIn;
  const bLines = bIn.length > maxLines ? bIn.slice(0, maxLines) : bIn;

  // Intern lines as integers: comparisons become cheap.
  const ids = new Map<string, number>();
  const intern = (s: string) => {
    let id = ids.get(s);
    if (id === undefined) ids.set(s, (id = ids.size));
    return id;
  };
  const a = Int32Array.from(aLines, intern);
  const b = Int32Array.from(bLines, intern);

  const ops: DiffOp[] = [];
  let approximate = false;
  const equal = (i: number, j: number) => ops.push({ type: 'equal', text: aLines[i]!, a: i, b: j });
  const remove = (i: number) => ops.push({ type: 'remove', text: aLines[i]!, a: i });
  const add = (j: number) => ops.push({ type: 'add', text: bLines[j]!, b: j });

  const lcs = (a0: number, a1: number, b0: number, b1: number) => {
    const n = a1 - a0;
    const m = b1 - b0;
    const w = m + 1;
    // L[i][j] = LCS length of a[a0+i..a1) and b[b0+j..b1)
    const L = n < 65_535 && m < 65_535 ? new Uint16Array((n + 1) * w) : new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      const ai = a[a0 + i];
      const row = i * w;
      const next = row + w;
      for (let j = m - 1; j >= 0; j--) {
        L[row + j] = ai === b[b0 + j] ? L[next + j + 1]! + 1 : Math.max(L[next + j]!, L[row + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[a0 + i] === b[b0 + j]) {
        equal(a0 + i, b0 + j);
        i++;
        j++;
      } else if (L[(i + 1) * w + j]! >= L[i * w + j + 1]!) {
        remove(a0 + i);
        i++;
      } else {
        add(b0 + j);
        j++;
      }
    }
    for (; i < n; i++) remove(a0 + i);
    for (; j < m; j++) add(b0 + j);
  };

  /** Lines unique in both ranges, as increasing (i, j) pairs (longest increasing subsequence). */
  const anchors = (a0: number, a1: number, b0: number, b1: number): [number, number][] => {
    const countA = new Map<number, number>();
    const posA = new Map<number, number>();
    for (let i = a0; i < a1; i++) {
      countA.set(a[i]!, (countA.get(a[i]!) ?? 0) + 1);
      posA.set(a[i]!, i);
    }
    const countB = new Map<number, number>();
    const posB = new Map<number, number>();
    for (let j = b0; j < b1; j++) {
      countB.set(b[j]!, (countB.get(b[j]!) ?? 0) + 1);
      posB.set(b[j]!, j);
    }
    const pairs: [number, number][] = [];
    for (let i = a0; i < a1; i++) {
      const id = a[i]!;
      if (countA.get(id) === 1 && countB.get(id) === 1) pairs.push([i, posB.get(id)!]);
    }
    if (pairs.length === 0) return [];
    // LIS over j (pairs are already ordered by i).
    const tails: number[] = [];
    const prev = new Int32Array(pairs.length).fill(-1);
    for (let k = 0; k < pairs.length; k++) {
      const j = pairs[k]![1];
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pairs[tails[mid]!]![1] < j) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) prev[k] = tails[lo - 1]!;
      tails[lo] = k;
    }
    const out: [number, number][] = [];
    for (let k = tails[tails.length - 1]!; k >= 0; k = prev[k]!) out.push(pairs[k]!);
    return out.reverse();
  };

  const diffRange = (a0: number, a1: number, b0: number, b1: number, depth: number): void => {
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) equal(a0++, b0++);
    let suffix = 0;
    while (a1 - suffix > a0 && b1 - suffix > b0 && a[a1 - 1 - suffix] === b[b1 - 1 - suffix]) suffix++;
    const aEnd = a1 - suffix;
    const bEnd = b1 - suffix;
    const n = aEnd - a0;
    const m = bEnd - b0;
    if (n === 0) for (let j = b0; j < bEnd; j++) add(j);
    else if (m === 0) for (let i = a0; i < aEnd; i++) remove(i);
    else if (n * m <= maxCells) lcs(a0, aEnd, b0, bEnd);
    else {
      const anchorList = depth < 12 ? anchors(a0, aEnd, b0, bEnd) : [];
      if (anchorList.length === 0) {
        approximate = true;
        for (let i = a0; i < aEnd; i++) remove(i);
        for (let j = b0; j < bEnd; j++) add(j);
      } else {
        let ca = a0;
        let cb = b0;
        for (const [i, j] of anchorList) {
          diffRange(ca, i, cb, j, depth + 1);
          equal(i, j);
          ca = i + 1;
          cb = j + 1;
        }
        diffRange(ca, aEnd, cb, bEnd, depth + 1);
      }
    }
    for (let k = 0; k < suffix; k++) equal(aEnd + k, bEnd + k);
  };

  diffRange(0, a.length, 0, b.length, 0);

  let added = 0;
  let removed = 0;
  let same = 0;
  for (const op of ops) {
    if (op.type === 'add') added++;
    else if (op.type === 'remove') removed++;
    else same++;
  }
  return { ops, approximate, truncated, added, removed, equal: same };
}

/* ───────────── Side-by-side rows ───────────── */

export interface SideCell {
  /** 1-based line number. */
  n: number;
  text: string;
  type: DiffOpType;
}

export interface SideRow {
  left?: SideCell;
  right?: SideCell;
}

/** Pair removals with additions so changed lines sit next to each other. */
export function sideBySide(ops: readonly DiffOp[]): SideRow[] {
  const rows: SideRow[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.type === 'equal') {
      rows.push({ left: { n: op.a! + 1, text: op.text, type: 'equal' }, right: { n: op.b! + 1, text: op.text, type: 'equal' } });
      i++;
      continue;
    }
    const removes: DiffOp[] = [];
    const adds: DiffOp[] = [];
    while (i < ops.length && ops[i]!.type !== 'equal') {
      const o = ops[i]!;
      if (o.type === 'remove') removes.push(o);
      else adds.push(o);
      i++;
    }
    const n = Math.max(removes.length, adds.length);
    for (let k = 0; k < n; k++) {
      const r = removes[k];
      const ad = adds[k];
      rows.push({
        left: r ? { n: r.a! + 1, text: r.text, type: 'remove' } : undefined,
        right: ad ? { n: ad.b! + 1, text: ad.text, type: 'add' } : undefined,
      });
    }
  }
  return rows;
}

export type DisplayRow = { kind: 'row'; row: SideRow } | { kind: 'skip'; count: number; from: number };

/**
 * Hide long runs of unchanged rows, keeping `context` rows around every change. A run whose hidden part
 * starts at an index listed in `expanded` is shown in full ("show 120 unchanged lines").
 */
export function collapseUnchanged(rows: readonly SideRow[], context = 3, expanded?: ReadonlySet<number>): DisplayRow[] {
  const changed = (r: SideRow) => r.left?.type !== 'equal' || r.right?.type !== 'equal';
  const out: DisplayRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (changed(rows[i]!)) {
      out.push({ kind: 'row', row: rows[i]! });
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && !changed(rows[j]!)) j++;
    const runStart = i;
    const runEnd = j; // exclusive
    const keepHead = runStart === 0 ? 0 : context;
    const keepTail = runEnd === rows.length ? 0 : context;
    const hidden = runEnd - runStart - keepHead - keepTail;
    if (hidden <= 1 || expanded?.has(runStart + keepHead)) {
      for (let k = runStart; k < runEnd; k++) out.push({ kind: 'row', row: rows[k]! });
    } else {
      for (let k = runStart; k < runStart + keepHead; k++) out.push({ kind: 'row', row: rows[k]! });
      out.push({ kind: 'skip', count: hidden, from: runStart + keepHead });
      for (let k = runEnd - keepTail; k < runEnd; k++) out.push({ kind: 'row', row: rows[k]! });
    }
    i = j;
  }
  return out;
}
