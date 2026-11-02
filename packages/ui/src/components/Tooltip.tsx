import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Portal, useFloating, type Align, type Side } from './floating';
import { Kbd } from './Kbd';

let lastHiddenAt = 0;
const WARM_MS = 500;

export interface TooltipProps {
  /** Tooltip text (or rich content). When empty, only the child is rendered. */
  content: ReactNode;
  /** Shortcut hint rendered as keycaps, e.g. "Mod+K". */
  shortcut?: string;
  side?: Side;
  align?: Align;
  /** Open delay in ms (skipped right after another tooltip closed). Default 450. */
  delay?: number;
  disabled?: boolean;
  /** Wrapper class (the wrapper uses `display: contents`). */
  className?: string;
  children: ReactNode;
}

/**
 * Hover/focus tooltip. Wraps its child in a `display: contents` span, so any element works as the
 * trigger without ref plumbing. Icon-only buttons should still carry an `aria-label`.
 */
export function Tooltip({ content, shortcut, side = 'bottom', align = 'center', delay = 450, disabled, className, children }: TooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  const placement = useFloating(open, anchorRef, boxRef, { side, align, offset: 6 });

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const show = () => {
    if (disabled || !content) return;
    clear();
    const warm = Date.now() - lastHiddenAt < WARM_MS;
    timer.current = setTimeout(() => setOpen(true), warm ? 0 : delay);
  };
  const hide = () => {
    clear();
    setOpen((o) => {
      if (o) lastHiddenAt = Date.now();
      return false;
    });
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', hide, true);
    };
  }, [open]);

  useEffect(() => clear, []);
  useEffect(() => {
    if (disabled) hide();
  }, [disabled]);

  return (
    <>
      <span
        ref={anchorRef}
        className={clsx('tt-anchor', className)}
        onPointerEnter={show}
        onPointerLeave={hide}
        onPointerDown={hide}
        onFocus={(e) => {
          if ((e.target as HTMLElement).matches?.(':focus-visible')) show();
        }}
        onBlur={hide}
      >
        {children}
      </span>
      {open && content ? (
        <Portal>
          <div
            ref={boxRef}
            id={id}
            role="tooltip"
            className={clsx('tooltip', placement && `tooltip--${placement.side}`)}
            style={{ top: placement?.top ?? -9999, left: placement?.left ?? -9999, visibility: placement ? 'visible' : 'hidden' }}
          >
            <span className="tooltip__text">{content}</span>
            {shortcut ? <Kbd combo={shortcut} size="sm" /> : null}
          </div>
        </Portal>
      ) : null}
    </>
  );
}
