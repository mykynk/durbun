import type { ComponentPropsWithRef, ReactNode } from 'react';
import { clsx } from 'clsx';
import type { IconType } from './Icons';
import { Spinner } from './Spinner';
import { Tooltip } from './Tooltip';
import { Kbd } from './Kbd';
import type { Side } from './floating';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading lucide icon. */
  icon?: IconType;
  /** Trailing lucide icon. */
  iconRight?: IconType;
  loading?: boolean;
  /** Shortcut hint shown inside the button (keycaps). */
  kbd?: string;
  fullWidth?: boolean;
  children?: ReactNode;
}

const ICON_SIZE: Record<ButtonSize, number> = { sm: 14, md: 16, lg: 16 };

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconRight: IconRight,
  loading,
  kbd,
  fullWidth,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx('btn', `btn--${variant}`, `btn--${size}`, fullWidth && 'btn--full', loading && 'btn--loading', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={ICON_SIZE[size]} /> : Icon ? <Icon size={ICON_SIZE[size]} aria-hidden /> : null}
      {children !== undefined && children !== null && children !== false ? <span className="btn__label">{children}</span> : null}
      {IconRight ? <IconRight size={ICON_SIZE[size]} aria-hidden /> : null}
      {kbd ? <Kbd combo={kbd} size="sm" className="btn__kbd" /> : null}
    </button>
  );
}

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  icon: IconType;
  /** Accessible name + tooltip text (required for icon-only buttons). */
  label: string;
  /** Shortcut shown in the tooltip. */
  shortcut?: string;
  size?: 'xs' | 'sm' | 'md';
  variant?: 'ghost' | 'subtle' | 'solid';
  /** Pressed/toggled state (aria-pressed). */
  active?: boolean;
  /** Small dot (true) or count badge on the icon. */
  badge?: boolean | number;
  tooltipSide?: Side;
  /** Disable the tooltip (e.g. inside a menu). */
  noTooltip?: boolean;
  tone?: 'default' | 'danger' | 'accent';
}

const IB_ICON: Record<NonNullable<IconButtonProps['size']>, number> = { xs: 13, sm: 14, md: 16 };

export function IconButton({
  icon: Icon,
  label,
  shortcut,
  size = 'md',
  variant = 'ghost',
  active,
  badge,
  tooltipSide = 'bottom',
  noTooltip,
  tone = 'default',
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const btn = (
    <button
      type={type}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={clsx('icon-btn', `icon-btn--${size}`, `icon-btn--${variant}`, tone !== 'default' && `icon-btn--${tone}`, active && 'is-active', className)}
      {...rest}
    >
      <Icon size={IB_ICON[size]} aria-hidden />
      {badge ? <span className={clsx('icon-btn__badge', typeof badge === 'number' && 'icon-btn__badge--count')}>{typeof badge === 'number' ? (badge > 99 ? '99+' : badge) : null}</span> : null}
    </button>
  );
  if (noTooltip) return btn;
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      {btn}
    </Tooltip>
  );
}
