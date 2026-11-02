import { describe, expect, it } from 'vitest';
import { collapseUnchanged, diffLines, sideBySide, splitLines, type DiffOp } from './diff';

/** Rebuild A and B from the ops (every diff must be lossless). */
function replay(ops: DiffOp[]): { a: string[]; b: string[] } {
  const a: string[] = [];
  const b: string[] = [];
  for (const op of ops) {
    if (op.type !== 'add') a.push(op.text);
    if (op.type !== 'remove') b.push(op.text);
  }
  return { a, b };
}

function lcsLength(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  return dp[0]![0]!;
}

describe('splitLines', () => {
  it('normalizes newlines and ignores one trailing newline', () => {
    expect(splitLines('a\r\nb\nc\n')).toEqual(['a', 'b', 'c']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('\n')).toEqual(['']);
  });
});

describe('diffLines', () => {
  it('reports identical inputs as equal', () => {
    const r = diffLines(['a', 'b'], ['a', 'b']);
    expect(r.ops.map((o) => o.type)).toEqual(['equal', 'equal']);
    expect(r).toMatchObject({ added: 0, removed: 0, equal: 2, approximate: false, truncated: false });
  });

  it('finds a single changed line in the middle', () => {
    const a = ['{', '  "id": 1,', '  "name": "Pamuk",', '  "age": 2', '}'];
    const b = ['{', '  "id": 1,', '  "name": "Boncuk",', '  "age": 2', '}'];
    const r = diffLines(a, b);
    expect(r.ops.filter((o) => o.type !== 'equal').map((o) => `${o.type}:${o.text.trim()}`)).toEqual(['remove:"name": "Pamuk",', 'add:"name": "Boncuk",']);
    expect(replay(r.ops)).toEqual({ a, b });
  });

  it('handles insertions and deletions at both ends and empty sides', () => {
    expect(diffLines([], ['x', 'y']).ops.map((o) => o.type)).toEqual(['add', 'add']);
    expect(diffLines(['x'], []).ops.map((o) => o.type)).toEqual(['remove']);
    const r = diffLines(['b', 'c'], ['a', 'b', 'c', 'd']);
    expect(r.ops.map((o) => o.type)).toEqual(['add', 'equal', 'equal', 'add']);
  });

  it('produces a minimal (LCS) diff on interleaved changes', () => {
    const a = 'a b c a b b a'.split(' ');
    const b = 'c b a b a c'.split(' ');
    const r = diffLines(a, b);
    expect(replay(r.ops)).toEqual({ a, b });
    expect(r.equal).toBe(lcsLength(a, b));
  });

  it('keeps line numbers for every op', () => {
    const r = diffLines(['x', 'y', 'z'], ['x', 'q', 'z']);
    expect(r.ops).toEqual([
      { type: 'equal', text: 'x', a: 0, b: 0 },
      { type: 'remove', text: 'y', a: 1 },
      { type: 'add', text: 'q', b: 1 },
      { type: 'equal', text: 'z', a: 2, b: 2 },
    ]);
  });

  it('splits big inputs at unique anchor lines instead of a huge DP table', () => {
    const a: string[] = [];
    const b: string[] = [];
    for (let i = 0; i < 3000; i++) {
      a.push(`  "item${i}": ${i},`);
      b.push(i % 500 === 0 ? `  "item${i}": ${i + 1},` : `  "item${i}": ${i},`);
    }
    const r = diffLines(a, b, { maxCells: 10_000 });
    expect(replay(r.ops)).toEqual({ a, b });
    expect(r.removed).toBe(6);
    expect(r.added).toBe(6);
    expect(r.approximate).toBe(false);
  });

  it('falls back to a block replacement (approximate) when nothing anchors a huge middle', () => {
    const a = Array.from({ length: 400 }, (_, i) => (i % 2 ? 'x' : 'y'));
    const b = Array.from({ length: 400 }, (_, i) => (i % 3 ? 'x' : 'z'));
    const r = diffLines(a, b, { maxCells: 1000 });
    expect(r.approximate).toBe(true);
    expect(replay(r.ops)).toEqual({ a, b });
  });

  it('truncates inputs longer than maxLines', () => {
    const r = diffLines(['1', '2', '3'], ['1', '2', '4'], { maxLines: 2 });
    expect(r.truncated).toBe(true);
    expect(r.ops.every((o) => o.type === 'equal')).toBe(true);
  });
});

describe('side by side + collapsing', () => {
  it('pairs removed and added lines on one row', () => {
    const rows = sideBySide(diffLines(['a', 'old1', 'old2', 'z'], ['a', 'new1', 'z']).ops);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toEqual({ left: { n: 2, text: 'old1', type: 'remove' }, right: { n: 2, text: 'new1', type: 'add' } });
    expect(rows[2]).toEqual({ left: { n: 3, text: 'old2', type: 'remove' }, right: undefined });
  });

  it('hides long unchanged runs but keeps context around changes', () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const b = a.slice();
    b[15] = 'changed';
    const display = collapseUnchanged(sideBySide(diffLines(a, b).ops), 3);
    const kinds = display.map((d) => (d.kind === 'skip' ? `skip${d.count}` : 'row'));
    expect(kinds[0]).toBe('skip12');
    expect(kinds.filter((k) => k === 'row')).toHaveLength(7);
    expect(kinds[kinds.length - 1]).toBe('skip11');
  });

  it('does not create a skip for a single hidden row', () => {
    const rows = sideBySide(diffLines(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], ['X', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'Y']).ops);
    const display = collapseUnchanged(rows, 3);
    expect(display.every((d) => d.kind === 'row')).toBe(true);
  });
});
