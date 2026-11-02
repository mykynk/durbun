import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { clsx } from 'clsx';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { t } from '../i18n/core';
import { Portal } from './floating';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface ToastInput {
  kind?: ToastKind;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  /** ms; 0 = stays until dismissed. Default: 4 s (errors 8 s). */
  duration?: number;
  /** Reuse an id to update/replace an existing toast. */
  id?: string;
}

export interface ToastItem extends Required<Pick<ToastInput, 'title'>> {
  id: string;
  kind: ToastKind;
  description?: string;
  action?: { label: string; onClick: () => void };
  duration: number;
  count: number;
  createdAt: number;
}

interface ToastState {
  toasts: ToastItem[];
}

const useToasts = create<ToastState>()(() => ({ toasts: [] }));
let seq = 0;
const MAX_VISIBLE = 4;

function push(input: ToastInput): string {
  const kind = input.kind ?? 'info';
  const duration = input.duration ?? (kind === 'error' ? 8000 : 4000);
  const now = Date.now();
  const { toasts } = useToasts.getState();
  // Same toast shown again shortly → bump a ×N counter instead of stacking duplicates.
  const dup = toasts.find((x) => !input.id && x.title === input.title && x.description === input.description && x.kind === kind && now - x.createdAt < 8000);
  if (dup) {
    useToasts.setState({ toasts: toasts.map((x) => (x === dup ? { ...x, count: x.count + 1, createdAt: now } : x)) });
    return dup.id;
  }
  const id = input.id ?? `t${++seq}`;
  const item: ToastItem = { id, kind, title: input.title, description: input.description, action: input.action, duration, count: 1, createdAt: now };
  const rest = toasts.filter((x) => x.id !== id);
  useToasts.setState({ toasts: [...rest, item].slice(-MAX_VISIBLE) });
  return id;
}

export function dismissToast(id: string): void {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
}

type ToastFn = ((input: ToastInput | string) => string) & {
  info(title: string, opts?: Omit<ToastInput, 'title' | 'kind'>): string;
  success(title: string, opts?: Omit<ToastInput, 'title' | 'kind'>): string;
  warn(title: string, opts?: Omit<ToastInput, 'title' | 'kind'>): string;
  error(title: string, opts?: Omit<ToastInput, 'title' | 'kind'>): string;
  dismiss(id: string): void;
};

/**
 * Show a toast. `toast('Kaydedildi')`, `toast.error('Gönderilemedi', { description: err.message })`,
 * `toast({ kind: 'success', title, action: { label: 'Göster', onClick } })`. Returns the toast id.
 */
export const toast: ToastFn = Object.assign((input: ToastInput | string) => push(typeof input === 'string' ? { title: input } : input), {
  info: (title: string, opts?: Omit<ToastInput, 'title' | 'kind'>) => push({ ...opts, title, kind: 'info' }),
  success: (title: string, opts?: Omit<ToastInput, 'title' | 'kind'>) => push({ ...opts, title, kind: 'success' }),
  warn: (title: string, opts?: Omit<ToastInput, 'title' | 'kind'>) => push({ ...opts, title, kind: 'warn' }),
  error: (title: string, opts?: Omit<ToastInput, 'title' | 'kind'>) => push({ ...opts, title, kind: 'error' }),
  dismiss: dismissToast,
});

const ICONS = { info: Info, success: CircleCheck, warn: TriangleAlert, error: CircleAlert } as const;

function ToastView({ item }: { item: ToastItem }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remaining = useRef(item.duration);
  const startedAt = useRef(Date.now());

  const start = () => {
    if (!item.duration) return;
    startedAt.current = Date.now();
    timer.current = setTimeout(() => dismissToast(item.id), remaining.current);
  };
  const pause = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    remaining.current = Math.max(800, remaining.current - (Date.now() - startedAt.current));
  };

  useEffect(() => {
    remaining.current = item.duration;
    start();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // restart the timer when the toast is bumped
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.createdAt, item.duration]);

  const Icon = ICONS[item.kind];
  return (
    <div
      className={clsx('toast', `toast--${item.kind}`)}
      role={item.kind === 'error' ? 'alert' : 'status'}
      onPointerEnter={pause}
      onPointerLeave={start}
      onFocus={pause}
      onBlur={start}
    >
      <Icon size={16} className="toast__icon" aria-hidden />
      <div className="toast__body">
        <div className="toast__title">
          {item.title}
          {item.count > 1 ? <span className="toast__count tnum">×{item.count}</span> : null}
        </div>
        {item.description ? <div className="toast__desc">{item.description}</div> : null}
      </div>
      {item.action ? (
        <button
          type="button"
          className="toast__action"
          onClick={() => {
            item.action?.onClick();
            dismissToast(item.id);
          }}
        >
          {item.action.label}
        </button>
      ) : null}
      <button type="button" className="toast__close" aria-label={t('common.close')} onClick={() => dismissToast(item.id)}>
        <X size={13} />
      </button>
    </div>
  );
}

/** Renders toasts (mount once, in App). */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <Portal>
      <div className="toaster" aria-live="polite">
        {toasts.map((item) => (
          <ToastView key={item.id} item={item} />
        ))}
      </div>
    </Portal>
  );
}
