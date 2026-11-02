import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { IconType } from './Icons';

/* ───────────── Toolbar ───────────── */

/** Horizontal bar of controls (feature headers). Children are laid out with 4px gaps. */
export function Toolbar({ children, className, dense, 'aria-label': ariaLabel }: { children: ReactNode; className?: string; dense?: boolean; 'aria-label'?: string }) {
  return (
    <div role="toolbar" aria-label={ariaLabel} className={clsx('toolbar', dense && 'toolbar--dense', className)}>
      {children}
    </div>
  );
}

export function ToolbarSeparator() {
  return <span className="toolbar__sep" role="separator" aria-orientation="vertical" />;
}

export function ToolbarSpacer() {
  return <span className="toolbar__spacer" />;
}

/** Groups controls visually (no gap). */
export function ToolbarGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('toolbar__group', className)}>{children}</div>;
}

/* ───────────── Card ───────────── */

export interface CardProps {
  title?: ReactNode;
  icon?: IconType;
  /** Right side of the header. */
  actions?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  padding?: 'none' | 'sm' | 'md';
  tone?: 'default' | 'accent' | 'warn' | 'danger';
}

export function Card({ title, icon: Icon, actions, description, children, className, padding = 'md', tone = 'default' }: CardProps) {
  return (
    <section className={clsx('card', `card--pad-${padding}`, tone !== 'default' && `card--${tone}`, className)}>
      {title || actions ? (
        <header className="card__header">
          {Icon ? (
            <span className="card__icon">
              <Icon size={16} aria-hidden />
            </span>
          ) : null}
          <div className="card__titles">
            {title ? <h3 className="card__title">{title}</h3> : null}
            {description ? <p className="card__desc">{description}</p> : null}
          </div>
          {actions ? <div className="card__actions">{actions}</div> : null}
        </header>
      ) : null}
      {children ? <div className="card__body">{children}</div> : null}
    </section>
  );
}

/* ───────────── Callout ───────────── */

const CALLOUT_ICON: Record<'info' | 'success' | 'warn' | 'danger', IconType> = {
  info: Info,
  success: CircleCheck,
  warn: TriangleAlert,
  danger: CircleAlert,
};

export interface CalloutProps {
  tone?: 'info' | 'success' | 'warn' | 'danger';
  title?: ReactNode;
  icon?: IconType | null;
  children?: ReactNode;
  /** Right-aligned actions (buttons). */
  actions?: ReactNode;
  className?: string;
  compact?: boolean;
}

/** Inline message box (hints, warnings, errors). */
export function Callout({ tone = 'info', title, icon, children, actions, className, compact }: CalloutProps) {
  const Icon = icon === null ? null : (icon ?? CALLOUT_ICON[tone]);
  return (
    <div className={clsx('callout', `callout--${tone}`, compact && 'callout--compact', className)} role={tone === 'danger' ? 'alert' : 'status'}>
      {Icon ? <Icon size={16} className="callout__icon" aria-hidden /> : null}
      <div className="callout__body">
        {title ? <div className="callout__title">{title}</div> : null}
        {children ? <div className="callout__text">{children}</div> : null}
      </div>
      {actions ? <div className="callout__actions">{actions}</div> : null}
    </div>
  );
}

/* ───────────── EmptyState ───────────── */

export interface EmptyStateProps {
  icon?: IconType;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons under the text. */
  actions?: ReactNode;
  /** Extra content under the actions (cards, lists…). */
  children?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  tone?: 'neutral' | 'accent' | 'danger';
  className?: string;
}

/** Centered "nothing here yet" / "no results" / error state. */
export function EmptyState({ icon: Icon, title, description, actions, children, size = 'md', tone = 'neutral', className }: EmptyStateProps) {
  return (
    <div className={clsx('empty', `empty--${size}`, `empty--${tone}`, className)}>
      {Icon ? (
        <div className="empty__icon">
          <Icon size={size === 'sm' ? 18 : 22} aria-hidden />
        </div>
      ) : null}
      <div className="empty__title">{title}</div>
      {description ? <div className="empty__desc">{description}</div> : null}
      {actions ? <div className="empty__actions">{actions}</div> : null}
      {children ? <div className="empty__extra">{children}</div> : null}
    </div>
  );
}
