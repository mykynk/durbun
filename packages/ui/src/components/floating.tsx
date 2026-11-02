import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/** Container for overlays (tooltips, popovers, menus, dialogs, toasts), outside the app root. */
export function layerRoot(): HTMLElement {
  let el = document.getElementById('durbun-layers');
  if (!el) {
    el = document.createElement('div');
    el.id = 'durbun-layers';
    document.body.appendChild(el);
  }
  return el;
}

export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, layerRoot());
}

export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Align = 'start' | 'center' | 'end';

export interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Placement {
  top: number;
  left: number;
  side: Side;
  /** Max height that fits on the chosen side. */
  maxHeight: number;
}

const MARGIN = 8;

/** Compute a viewport position for a floating box next to an anchor; flips/clamps to stay visible. */
export function computePlacement(
  anchor: AnchorRect,
  box: { width: number; height: number },
  side: Side,
  align: Align,
  offset: number,
  viewport: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight },
): Placement {
  const spaceBelow = viewport.height - (anchor.top + anchor.height) - offset - MARGIN;
  const spaceAbove = anchor.top - offset - MARGIN;
  const spaceRight = viewport.width - (anchor.left + anchor.width) - offset - MARGIN;
  const spaceLeft = anchor.left - offset - MARGIN;
  let s = side;
  if (s === 'bottom' && box.height > spaceBelow && spaceAbove > spaceBelow) s = 'top';
  else if (s === 'top' && box.height > spaceAbove && spaceBelow > spaceAbove) s = 'bottom';
  else if (s === 'right' && box.width > spaceRight && spaceLeft > spaceRight) s = 'left';
  else if (s === 'left' && box.width > spaceLeft && spaceRight > spaceLeft) s = 'right';

  let top: number;
  let left: number;
  if (s === 'bottom' || s === 'top') {
    top = s === 'bottom' ? anchor.top + anchor.height + offset : anchor.top - offset - box.height;
    left = align === 'start' ? anchor.left : align === 'end' ? anchor.left + anchor.width - box.width : anchor.left + anchor.width / 2 - box.width / 2;
  } else {
    left = s === 'right' ? anchor.left + anchor.width + offset : anchor.left - offset - box.width;
    top = align === 'start' ? anchor.top : align === 'end' ? anchor.top + anchor.height - box.height : anchor.top + anchor.height / 2 - box.height / 2;
  }
  left = Math.max(MARGIN, Math.min(left, viewport.width - box.width - MARGIN));
  top = Math.max(MARGIN, Math.min(top, viewport.height - box.height - MARGIN));
  const maxHeight = s === 'bottom' ? spaceBelow : s === 'top' ? spaceAbove : viewport.height - 2 * MARGIN;
  return { top, left, side: s, maxHeight: Math.max(120, maxHeight) };
}

export type AnchorSource = RefObject<HTMLElement | null> | { x: number; y: number } | null;

function anchorRect(anchor: AnchorSource): AnchorRect | null {
  if (!anchor) return null;
  if ('current' in anchor) {
    const el = anchor.current;
    if (!el) return null;
    const target = getComputedStyle(el).display === 'contents' ? (el.firstElementChild as HTMLElement | null) : el;
    const r = (target ?? el).getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }
  return { top: anchor.y, left: anchor.x, width: 0, height: 0 };
}

/**
 * Position `floatingRef` next to `anchor` while `open`. Re-measures on resize/scroll.
 * Returns null until the first measurement (render the box hidden until then).
 */
export function useFloating(
  open: boolean,
  anchor: AnchorSource,
  floatingRef: RefObject<HTMLElement | null>,
  opts: { side?: Side; align?: Align; offset?: number } = {},
): Placement | null {
  const { side = 'bottom', align = 'start', offset = 6 } = opts;
  const [placement, setPlacement] = useState<Placement | null>(null);
  const ax = anchor && !('current' in anchor) ? anchor.x : undefined;
  const ay = anchor && !('current' in anchor) ? anchor.y : undefined;
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const update = () => {
      const rect = anchorRect(anchor);
      const el = floatingRef.current;
      if (!rect || !el) return;
      const box = { width: el.offsetWidth, height: el.offsetHeight };
      const next = computePlacement(rect, box, side, align, offset);
      setPlacement((p) => (p && p.top === next.top && p.left === next.left && p.side === next.side && p.maxHeight === next.maxHeight ? p : next));
    };
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (floatingRef.current) ro?.observe(floatingRef.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
    // anchor objects for points are compared by coordinates
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, side, align, offset, ax, ay, anchor && 'current' in anchor ? anchor : null]);
  return placement;
}

/** Focusable descendants (for focus traps and roving focus). */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  const sel =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
  return [...root.querySelectorAll<HTMLElement>(sel)].filter((el) => !el.hasAttribute('inert') && el.getClientRects().length > 0);
}
