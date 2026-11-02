import { memo, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import type { LogLevel, NetworkState } from '@durbun/protocol';
import { hashHue } from '../lib/hash';
import { t } from '../i18n/core';
import type { IconType } from './Icons';
import { Spinner } from './Spinner';

export type Tone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info';

/* ───────────── Chip ───────────── */

export interface ChipProps {
  children: ReactNode;
  tone?: Tone;
  size?: 'sm' | 'md';
  icon?: IconType;
  /** Shows a remove (×) button. */
  onRemove?: () => void;
  removeLabel?: string;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  active?: boolean;
  title?: string;
  mono?: boolean;
  className?: string;
}

export function Chip({ children, tone = 'neutral', size = 'md', icon: Icon, onRemove, removeLabel, onClick, active, title, mono, className }: ChipProps) {
  const cls = clsx('chip', `chip--${tone}`, `chip--${size}`, onClick && 'chip--clickable', active && 'is-active', mono && 'mono', className);
  const inner = (
    <>
      {Icon ? <Icon size={size === 'sm' ? 12 : 13} aria-hidden /> : null}
      <span className="chip__label">{children}</span>
    </>
  );
  return (
    <span className={cls} title={title}>
      {onClick ? (
        <button type="button" className="chip__main" onClick={onClick} aria-pressed={active}>
          {inner}
        </button>
      ) : (
        inner
      )}
      {onRemove ? (
        <button type="button" className="chip__remove" aria-label={removeLabel ?? t('common.remove')} onClick={onRemove}>
          <X size={11} strokeWidth={2.25} />
        </button>
      ) : null}
    </span>
  );
}

/* ───────────── CountBadge ───────────── */

/** Compact count pill for tabs/sidebar ("12", "99+"). Renders nothing for 0 unless `showZero`. */
export function CountBadge({ count, tone = 'neutral', max = 999, showZero, title, className }: { count: number; tone?: Tone; max?: number; showZero?: boolean; title?: string; className?: string }) {
  if (!count && !showZero) return null;
  return (
    <span className={clsx('count-badge', `count-badge--${tone}`, 'tnum', className)} title={title}>
      {count > max ? `${max}+` : count}
    </span>
  );
}

/* ───────────── StatusDot ───────────── */

export function StatusDot({ tone = 'neutral', pulse, size = 8, title, className }: { tone?: Tone; pulse?: boolean; size?: number; title?: string; className?: string }) {
  return (
    <span
      className={clsx('dot', `dot--${tone}`, pulse && 'dot--pulse', className)}
      style={{ width: size, height: size } as CSSProperties}
      title={title}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    />
  );
}

/* ───────────── TagChip ───────────── */

export interface TagChipProps {
  name: string;
  /** Click → filter by this tag. */
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  /** Alt/Option-click → exclude this tag. */
  onExclude?: (e: MouseEvent<HTMLElement>) => void;
  title?: string;
  size?: 'sm' | 'md';
  className?: string;
  /** Max width in px before truncating (default 180). */
  maxWidth?: number;
}

/** Tag/process chip with a stable hash color (same name → same color). Cheap enough for log rows. */
export const TagChip = memo(function TagChip({ name, onClick, onExclude, title, size = 'sm', className, maxWidth = 180 }: TagChipProps) {
  const style = { '--h': hashHue(name), maxWidth } as CSSProperties;
  const cls = clsx('tag-chip', `tag-chip--${size}`, (onClick || onExclude) && 'tag-chip--clickable', className);
  if (!onClick && !onExclude) {
    return (
      <span className={cls} style={style} title={title ?? name}>
        {name}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cls}
      style={style}
      title={title ?? name}
      onClick={(e) => {
        if (e.altKey && onExclude) onExclude(e);
        else onClick?.(e);
      }}
    >
      {name}
    </button>
  );
});

/* ───────────── LevelBadge ───────────── */

const LEVEL_TEXT: Record<LogLevel, string> = { verbose: 'VERBOSE', debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR', fatal: 'FATAL' };
const LEVEL_LETTER: Record<LogLevel, string> = { verbose: 'V', debug: 'D', info: 'I', warn: 'W', error: 'E', fatal: 'F' };

/** Technical level names are written literally (never CSS uppercase — Turkish "info" → "İNFO"). */
export function levelLabel(level: LogLevel, variant: 'full' | 'letter' = 'full'): string {
  return variant === 'letter' ? LEVEL_LETTER[level] : LEVEL_TEXT[level];
}

export const LevelBadge = memo(function LevelBadge({ level, variant = 'pill', className }: { level: LogLevel; variant?: 'pill' | 'letter' | 'text'; className?: string }) {
  return (
    <span className={clsx('lvl', `lvl--${level}`, `lvl--${variant}`, className)} title={t(`common.levelHint.${level}`)}>
      {variant === 'letter' ? LEVEL_LETTER[level] : LEVEL_TEXT[level]}
    </span>
  );
});

/* ───────────── MethodBadge ───────────── */

const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export function methodClass(method: string): string {
  const m = method.toUpperCase();
  return KNOWN_METHODS.has(m) ? m.toLowerCase() : 'other';
}

export const MethodBadge = memo(function MethodBadge({ method, className }: { method: string; className?: string }) {
  const m = method.toUpperCase();
  return <span className={clsx('method', `method--${methodClass(m)}`, className)}>{m === '?' ? '???' : m}</span>;
});

/* ───────────── StatusBadge ───────────── */

export function statusClass(status: number | undefined, state: NetworkState): 'pending' | 'fail' | '2xx' | '3xx' | '4xx' | '5xx' | 'other' {
  if (state === 'pending') return 'pending';
  if (state === 'failed' || state === 'cancelled') return 'fail';
  if (!status) return 'other';
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  if (status >= 200) return '2xx';
  return 'other';
}

export const StatusBadge = memo(function StatusBadge({
  status,
  state,
  error,
  statusText,
  className,
}: {
  status?: number;
  state: NetworkState;
  error?: string;
  statusText?: string;
  className?: string;
}) {
  const cls = statusClass(status, state);
  if (state === 'pending') {
    return (
      <span className={clsx('status', 'status--pending', className)} title={t('common.net.pending')}>
        <Spinner size={11} />
      </span>
    );
  }
  if (state === 'failed' || state === 'cancelled') {
    return (
      <span className={clsx('status', 'status--fail', className)} title={error || t(state === 'failed' ? 'common.net.failed' : 'common.net.cancelled')}>
        {state === 'failed' ? t('common.net.failedShort') : t('common.net.cancelledShort')}
      </span>
    );
  }
  return (
    <span className={clsx('status', `status--${cls}`, 'tnum', className)} title={statusText ? `${status} ${statusText}` : undefined}>
      {status ?? '—'}
    </span>
  );
});
