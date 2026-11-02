import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { usePrefs } from '../data/stores/prefs';
import { useElementSize } from '../hooks';
import { t } from '../i18n/core';

export interface SplitPaneProps {
  /** Persistence key (stored in UI prefs `panelSizes`). Omit to keep the size in memory only. */
  id?: string;
  /** 'horizontal' = side by side (default), 'vertical' = stacked. */
  direction?: 'horizontal' | 'vertical';
  /** Which child has the explicit size (default 'second': a detail panel on the right/bottom). */
  sizedPane?: 'first' | 'second';
  /** Default size of the sized pane in px (double-click the divider to reset). */
  defaultSize: number;
  /** Minimum size of the sized pane in px (default 160). */
  minSize?: number;
  /** Maximum size: px, or a fraction (0–1] of the container (default 0.8). */
  maxSize?: number;
  /** Hide one pane (e.g. no selection → 'second'). */
  collapsed?: 'first' | 'second' | null;
  /**
   * Horizontal splits only: when the container is narrower than this (px), the sized pane floats
   * over the other one as an overlay (SPEC: < 900 px → detail panels become overlays). Default 900; 0 disables.
   */
  overlayBelow?: number;
  /** Escape / backdrop click while in overlay mode (typically clears the selection). */
  onOverlayDismiss?: () => void;
  children: [ReactNode, ReactNode];
  className?: string;
}

const MIN_OTHER = 140;

/** Resizable two-pane layout. Drag or use arrow keys on the divider; double-click resets. */
export function SplitPane({
  id,
  direction = 'horizontal',
  sizedPane = 'second',
  defaultSize,
  minSize = 160,
  maxSize = 0.8,
  collapsed = null,
  overlayBelow = 900,
  onOverlayDismiss,
  children,
  className,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const box = useElementSize(containerRef);
  const persisted = usePrefs((s) => (id ? s.panelSizes[id] : undefined));
  const setPanelSize = usePrefs((s) => s.setPanelSize);
  const [memorySize, setMemorySize] = useState<number | undefined>(undefined);
  const [dragSize, setDragSize] = useState<number | null>(null);
  const drag = useRef<{ start: number; startSize: number } | null>(null);

  const horizontal = direction === 'horizontal';
  const total = horizontal ? box.width : box.height;
  const maxPx = maxSize <= 1 ? Math.max(minSize, total * maxSize) : maxSize;
  const clamp = (v: number) => {
    let out = Math.min(Math.max(v, minSize), maxPx);
    if (total > 0) out = Math.min(out, Math.max(minSize, total - MIN_OTHER));
    return Math.round(out);
  };
  const stored = id ? persisted : memorySize;
  const size = clamp(dragSize ?? stored ?? defaultSize);
  const overlay = horizontal && overlayBelow > 0 && total > 0 && total < overlayBelow && collapsed === null;

  const commit = (v: number | undefined) => {
    if (id) setPanelSize(id, v);
    else setMemorySize(v);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { start: horizontal ? e.clientX : e.clientY, startSize: size };
    document.body.classList.add(horizontal ? 'is-resizing-h' : 'is-resizing-v');
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const pos = horizontal ? e.clientX : e.clientY;
    const delta = pos - d.start;
    setDragSize(clamp(sizedPane === 'second' ? d.startSize - delta : d.startSize + delta));
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove('is-resizing-h', 'is-resizing-v');
    if (dragSize !== null) commit(dragSize);
    setDragSize(null);
  };
  useEffect(() => () => document.body.classList.remove('is-resizing-h', 'is-resizing-v'), []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const growKeys = sizedPane === 'second' ? (horizontal ? ['ArrowLeft'] : ['ArrowUp']) : horizontal ? ['ArrowRight'] : ['ArrowDown'];
    const shrinkKeys = sizedPane === 'second' ? (horizontal ? ['ArrowRight'] : ['ArrowDown']) : horizontal ? ['ArrowLeft'] : ['ArrowUp'];
    if (growKeys.includes(e.key)) commit(clamp(size + step));
    else if (shrinkKeys.includes(e.key)) commit(clamp(size - step));
    else if (e.key === 'Home') commit(clamp(minSize));
    else if (e.key === 'End') commit(clamp(maxPx));
    else if (e.key === 'Enter') commit(undefined);
    else return;
    e.preventDefault();
  };

  const [first, second] = children;
  const sizedStyle: CSSProperties = { flex: `0 0 ${size}px` };
  const fluidStyle: CSSProperties = { flex: '1 1 0' };

  if (collapsed) {
    return (
      <div ref={containerRef} className={clsx('split', horizontal ? 'split--h' : 'split--v', className)}>
        <div className="split__pane" style={fluidStyle}>
          {collapsed === 'second' ? first : second}
        </div>
      </div>
    );
  }

  if (overlay) {
    const overlayWidth = Math.min(size, Math.max(280, total - 48));
    return (
      <div ref={containerRef} className={clsx('split', 'split--h', 'split--overlay', className)}>
        <div className="split__pane" style={fluidStyle}>
          {sizedPane === 'second' ? first : second}
        </div>
        <div className="split__scrim" onClick={() => onOverlayDismiss?.()} aria-hidden />
        <div
          className={clsx('split__floating', sizedPane === 'second' ? 'split__floating--right' : 'split__floating--left')}
          style={{ width: overlayWidth }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && onOverlayDismiss) {
              e.stopPropagation();
              onOverlayDismiss();
            }
          }}
        >
          {sizedPane === 'second' ? second : first}
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={clsx('split', horizontal ? 'split--h' : 'split--v', dragSize !== null && 'is-dragging', className)}>
      <div className="split__pane" style={sizedPane === 'first' ? sizedStyle : fluidStyle}>
        {first}
      </div>
      <div
        className="split__divider"
        role="separator"
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-valuenow={size}
        aria-valuemin={minSize}
        aria-valuemax={Math.round(maxPx)}
        aria-label={t('common.resize')}
        title={t('common.resizeHint')}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={() => commit(undefined)}
        onKeyDown={onKeyDown}
      />
      <div className="split__pane" style={sizedPane === 'second' ? sizedStyle : fluidStyle}>
        {second}
      </div>
    </div>
  );
}
