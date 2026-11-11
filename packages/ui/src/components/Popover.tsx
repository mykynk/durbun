import { useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Portal, focusableWithin, useFloating, type Align, type AnchorSource, type Side } from './floating';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** Element ref or viewport point ({x, y}) to attach to. */
  anchor: AnchorSource;
  side?: Side;
  align?: Align;
  offset?: number;
  children: ReactNode;
  className?: string;
  /** Fixed width (px) or 'anchor' to match the anchor's width. */
  width?: number | 'anchor';
  /** Move focus into the popover on open (default true). */
  autoFocus?: boolean;
  role?: 'dialog' | 'menu' | 'listbox';
  'aria-label'?: string;
  /** Close when focus leaves the popover (default false). */
  closeOnBlur?: boolean;
  style?: CSSProperties;
}

/** Floating panel anchored to an element/point. Closes on outside click and Escape. */
export function Popover(props: PopoverProps) {
  if (!props.open) return null;
  return <PopoverInner {...props} />;
}

function PopoverInner({
  onClose,
  anchor,
  side = 'bottom',
  align = 'start',
  offset = 6,
  children,
  className,
  width,
  autoFocus = true,
  role = 'dialog',
  closeOnBlur,
  style,
  ...aria
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const placement = useFloating(true, anchor, ref, { side, align, offset });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // The panel stays hidden until it is placed, and hidden elements cannot take focus: focus once it shows.
  const focused = useRef(false);
  useLayoutEffect(() => {
    if (!autoFocus || focused.current || !placement || !ref.current) return;
    focused.current = true;
    const first = focusableWithin(ref.current)[0];
    (first ?? ref.current).focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placement]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if (anchor && 'current' in anchor && anchor.current?.contains(target)) return;
      onCloseRef.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [anchor]);

  const restoreFocus = () => {
    if (anchor && 'current' in anchor) {
      const el = anchor.current;
      const target = el && getComputedStyle(el).display === 'contents' ? (el.firstElementChild as HTMLElement | null) : el;
      target?.focus?.({ preventScroll: true });
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      onClose();
      restoreFocus();
    }
  };

  let w: number | undefined;
  if (typeof width === 'number') w = width;
  else if (width === 'anchor' && anchor && 'current' in anchor && anchor.current) w = anchor.current.getBoundingClientRect().width;

  return (
    <Portal>
      <div
        ref={ref}
        role={role}
        aria-label={aria['aria-label']}
        tabIndex={-1}
        className={clsx('popover', className)}
        style={{
          ...style,
          top: placement?.top ?? -9999,
          left: placement?.left ?? -9999,
          width: w,
          maxHeight: placement ? Math.min(placement.maxHeight, 560) : undefined,
          visibility: placement ? 'visible' : 'hidden',
        }}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (closeOnBlur && !ref.current?.contains(e.relatedTarget as Node | null)) onClose();
        }}
      >
        {children}
      </div>
    </Portal>
  );
}
