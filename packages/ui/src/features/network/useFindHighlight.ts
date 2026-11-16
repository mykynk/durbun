import { useEffect, type RefObject } from 'react';
import { matchOffsets } from './model/findMatch';

/** Name of the CSS highlight (styled in network.css with `::highlight(durbun-net-find)`). */
const HIGHLIGHT = 'durbun-net-find';

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
type HighlightCtor = new (...ranges: Range[]) => unknown;

function registry(): { reg: HighlightRegistry; Ctor: HighlightCtor } | null {
  const reg = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
  const Ctor = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  return reg && Ctor ? { reg, Ctor } : null;
}

/**
 * Marks every occurrence of `needle` inside `ref` (the body search's text in the request detail) with the CSS
 * Custom Highlight API, and scrolls the first one into view once. The DOM is not changed, so viewers (code, JSON
 * tree, tables) keep working; re-run when `deps` change (content rendered, section switched). No-op in browsers
 * without the API and while `needle` is empty.
 */
export function useFindHighlight(ref: RefObject<HTMLElement | null>, needle: string | undefined, deps: readonly unknown[]): void {
  useEffect(() => {
    const api = registry();
    const root = ref.current;
    if (!api || !root || !needle) return;
    let scrolled = false;
    const paint = () => {
      const ranges: Range[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node && ranges.length < 500; node = walker.nextNode()) {
        const text = node.nodeValue ?? '';
        if (text.length < needle.length) continue;
        for (const [a, b] of matchOffsets(text, needle, 500 - ranges.length)) {
          const r = document.createRange();
          r.setStart(node, a);
          r.setEnd(node, b);
          ranges.push(r);
        }
      }
      api.reg.set(HIGHLIGHT, new api.Ctor(...ranges));
      if (!scrolled && ranges[0]) {
        scrolled = true;
        (ranges[0].startContainer.parentElement as HTMLElement | null)?.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    };
    // Viewers render lazily (JSON tree expanding to the match, virtualized code): paint after they settled, and
    // again when their content changes.
    const raf = requestAnimationFrame(paint);
    let pending = 0;
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(paint);
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(pending);
      mo.disconnect();
      api.reg.delete(HIGHLIGHT);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, needle, ...deps]);
}
