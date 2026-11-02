import { memo, type ReactNode } from 'react';

/** Case-insensitive (plain toLowerCase) occurrences of `query` in `text` as [start, end) ranges. */
export function findRanges(text: string, query: string, max = 1000): [number, number][] {
  const q = query.toLowerCase();
  if (!q) return [];
  const hay = text.toLowerCase();
  // toLowerCase can change length for a few characters (e.g. "İ"); fall back to no highlight then.
  if (hay.length !== text.length) return [];
  const out: [number, number][] = [];
  let i = hay.indexOf(q);
  while (i >= 0 && out.length < max) {
    out.push([i, i + q.length]);
    i = hay.indexOf(q, i + q.length);
  }
  return out;
}

/** Renders `text` with <mark> around matches of `query` (or explicit `ranges`). */
export const Highlight = memo(function Highlight({ text, query, ranges, className }: { text: string; query?: string; ranges?: [number, number][]; className?: string }) {
  const rs = ranges ?? (query ? findRanges(text, query) : []);
  if (rs.length === 0) return className ? <span className={className}>{text}</span> : <>{text}</>;
  const parts: ReactNode[] = [];
  let pos = 0;
  rs.forEach(([s, e], i) => {
    if (s > pos) parts.push(text.slice(pos, s));
    parts.push(
      <mark key={i} className="hl">
        {text.slice(s, e)}
      </mark>,
    );
    pos = e;
  });
  if (pos < text.length) parts.push(text.slice(pos));
  return <span className={className}>{parts}</span>;
});
