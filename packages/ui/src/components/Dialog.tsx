import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { create } from 'zustand';
import { clsx } from 'clsx';
import { TriangleAlert, X } from 'lucide-react';
import { pushModalLayer } from '../lib/shortcuts';
import { t } from '../i18n/core';
import { Portal, focusableWithin } from './floating';
import { Button } from './Button';
import type { IconType } from './Icons';

let openDialogs = 0;

function setAppInert(inert: boolean): void {
  const root = document.getElementById('root');
  if (!root) return;
  if (inert) root.setAttribute('inert', '');
  else root.removeAttribute('inert');
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  icon?: IconType;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  children?: ReactNode;
  /** Footer row (right-aligned buttons). */
  footer?: ReactNode;
  /** Focused on open (default: the first text field in the body, else the panel itself). */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Set false to focus the panel even when the body has text fields (default true). */
  autoFocusField?: boolean;
  /** Click on the backdrop closes (default true). */
  closeOnOverlay?: boolean;
  hideClose?: boolean;
  /** No header/body padding: render your own layout inside. */
  bare?: boolean;
  className?: string;
  bodyClassName?: string;
  'aria-label'?: string;
}

/**
 * Modal dialog: focus trap, Esc to close, restores focus, makes the app inert and suppresses global
 * shortcuts (unless registered with `allowInModal`).
 */
export function Dialog(props: DialogProps) {
  if (!props.open) return null;
  return <DialogInner {...props} />;
}

function DialogInner({
  onClose,
  title,
  description,
  icon: Icon,
  size = 'md',
  children,
  footer,
  initialFocus,
  autoFocusField = true,
  closeOnOverlay = true,
  hideClose,
  bare,
  className,
  bodyClassName,
  ...aria
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const downOnOverlay = useRef(false);

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const pop = pushModalLayer();
    openDialogs++;
    setAppInert(true);
    // Focus: explicit target → first text field in the body → the panel itself (Tab then walks the
    // controls). Avoids a focus ring on the close button when a dialog opens.
    const firstField = !autoFocusField ? null : bodyRef.current?.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])');
    const target = initialFocus?.current ?? firstField ?? panelRef.current;
    target?.focus({ preventScroll: true });
    return () => {
      pop();
      openDialogs = Math.max(0, openDialogs - 1);
      if (openDialogs === 0) setAppInert(false);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
    // run once per open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !panelRef.current) return;
    const items = focusableWithin(panelRef.current);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <Portal>
      <div
        className="dialog-overlay"
        onPointerDown={(e) => {
          downOnOverlay.current = e.target === e.currentTarget;
        }}
        onPointerUp={(e) => {
          if (closeOnOverlay && downOnOverlay.current && e.target === e.currentTarget) onClose();
          downOnOverlay.current = false;
        }}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          aria-describedby={description ? descId : undefined}
          aria-label={!title ? aria['aria-label'] : undefined}
          tabIndex={-1}
          className={clsx('dialog', `dialog--${size}`, bare && 'dialog--bare', className)}
          onKeyDown={onKeyDown}
        >
          {!bare && (title || !hideClose) ? (
            <header className="dialog__header">
              {Icon ? (
                <span className="dialog__icon">
                  <Icon size={18} aria-hidden />
                </span>
              ) : null}
              <div className="dialog__titles">
                {title ? (
                  <h2 id={titleId} className="dialog__title">
                    {title}
                  </h2>
                ) : null}
                {description ? (
                  <p id={descId} className="dialog__desc">
                    {description}
                  </p>
                ) : null}
              </div>
              {!hideClose ? (
                <button type="button" className="icon-btn icon-btn--ghost icon-btn--sm dialog__close" aria-label={t('common.close')} onClick={onClose}>
                  <X size={15} />
                </button>
              ) : null}
            </header>
          ) : null}
          <div ref={bodyRef} className={clsx(bare ? 'dialog__bare' : 'dialog__body', bodyClassName)}>
            {children}
          </div>
          {footer ? <footer className="dialog__footer">{footer}</footer> : null}
        </div>
      </div>
    </Portal>
  );
}

/* ───────────── confirm() ───────────── */

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button + warning icon. */
  danger?: boolean;
  icon?: IconType;
}

interface ConfirmRequest extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

const useConfirms = create<{ queue: ConfirmRequest[] }>()(() => ({ queue: [] }));
let confirmSeq = 0;

/** Promise-based confirmation dialog: `if (await confirm({ title: 'Temizlensin mi?', danger: true })) …` */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirms.setState((s) => ({ queue: [...s.queue, { ...opts, id: ++confirmSeq, resolve }] }));
  });
}

function settle(id: number, ok: boolean): void {
  const req = useConfirms.getState().queue.find((r) => r.id === id);
  useConfirms.setState((s) => ({ queue: s.queue.filter((r) => r.id !== id) }));
  req?.resolve(ok);
}

/** Renders pending confirm() dialogs (mount once, in App). */
export function ConfirmHost() {
  const current = useConfirms((s) => s.queue[0]);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Resolve dangling requests on unmount.
    return () => useConfirms.getState().queue.forEach((r) => r.resolve(false));
  }, []);
  if (!current) return null;
  const Icon = current.icon ?? (current.danger ? TriangleAlert : undefined);
  return (
    <Dialog
      open
      size="sm"
      onClose={() => settle(current.id, false)}
      title={current.title}
      icon={Icon}
      initialFocus={confirmRef}
      className={clsx('confirm', current.danger && 'confirm--danger')}
      footer={
        <>
          <Button variant="ghost" onClick={() => settle(current.id, false)}>
            {current.cancelLabel ?? t('common.cancel')}
          </Button>
          <Button ref={confirmRef} variant={current.danger ? 'danger' : 'primary'} onClick={() => settle(current.id, true)}>
            {current.confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      {current.message ? <div className="confirm__message">{current.message}</div> : null}
    </Dialog>
  );
}
