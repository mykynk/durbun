import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Check } from 'lucide-react';
import type { IconType } from './Icons';
import { Tooltip } from './Tooltip';

/* ───────────── Toggle (switch) ───────────── */

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  size?: 'sm' | 'md';
  /** Accessible name when there is no visible label. */
  'aria-label'?: string;
  className?: string;
  id?: string;
}

export function Toggle({ checked, onChange, label, description, disabled, size = 'md', className, id, ...aria }: ToggleProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const descId = description ? `${inputId}-desc` : undefined;
  const control = (
    <button
      id={inputId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={aria['aria-label']}
      aria-describedby={descId}
      disabled={disabled}
      className={clsx('switch', `switch--${size}`, checked && 'is-on')}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__thumb" />
    </button>
  );
  if (!label && !description) return <span className={className}>{control}</span>;
  return (
    <div className={clsx('toggle-row', disabled && 'is-disabled', className)}>
      <div className="toggle-row__text">
        {label ? (
          <label htmlFor={inputId} className="toggle-row__label">
            {label}
          </label>
        ) : null}
        {description ? (
          <div id={descId} className="toggle-row__desc">
            {description}
          </div>
        ) : null}
      </div>
      {control}
    </div>
  );
}

/* ───────────── Checkbox ───────────── */

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  /** Shows a dash instead of a check. */
  indeterminate?: boolean;
  className?: string;
  'aria-label'?: string;
}

export function Checkbox({ checked, onChange, label, disabled, indeterminate, className, ...aria }: CheckboxProps) {
  return (
    <label className={clsx('checkbox', disabled && 'is-disabled', className)}>
      <input
        type="checkbox"
        className="checkbox__input"
        checked={checked}
        disabled={disabled}
        aria-label={aria['aria-label']}
        ref={(el) => {
          if (el) el.indeterminate = Boolean(indeterminate);
        }}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={clsx('checkbox__box', (checked || indeterminate) && 'is-on')} aria-hidden>
        {indeterminate ? <span className="checkbox__dash" /> : checked ? <Check size={11} strokeWidth={3} /> : null}
      </span>
      {label ? <span className="checkbox__label">{label}</span> : null}
    </label>
  );
}

/* ───────────── Segmented control ───────────── */

export interface SegmentOption<T extends string> {
  value: T;
  label?: ReactNode;
  icon?: IconType;
  /** Tooltip (and accessible name for icon-only segments). */
  tooltip?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentOption<T>[];
  size?: 'sm' | 'md';
  'aria-label'?: string;
  className?: string;
}

/** Single-choice segmented control (radiogroup with arrow-key navigation). */
export function SegmentedControl<T extends string>({ value, onChange, options, size = 'md', className, ...aria }: SegmentedControlProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const enabled = options.filter((o) => !o.disabled);
    const idx = enabled.findIndex((o) => o.value === value);
    let next = idx;
    if (e.key === 'ArrowLeft') next = (idx - 1 + enabled.length) % enabled.length;
    if (e.key === 'ArrowRight') next = (idx + 1) % enabled.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = enabled.length - 1;
    const opt = enabled[next];
    if (opt) {
      onChange(opt.value);
      requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(opt.value)}"]`)?.focus());
    }
  };
  return (
    <div ref={ref} role="radiogroup" aria-label={aria['aria-label']} className={clsx('seg', `seg--${size}`, className)} onKeyDown={onKeyDown}>
      {options.map((o) => {
        const selected = o.value === value;
        const Icon = o.icon;
        const btn = (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={!o.label ? o.tooltip : undefined}
            data-value={o.value}
            tabIndex={selected ? 0 : -1}
            disabled={o.disabled}
            className={clsx('seg__item', selected && 'is-selected')}
            onClick={() => onChange(o.value)}
          >
            {Icon ? <Icon size={size === 'sm' ? 13 : 14} aria-hidden /> : null}
            {o.label ? <span>{o.label}</span> : null}
          </button>
        );
        return o.tooltip ? (
          <Tooltip key={o.value} content={o.tooltip}>
            {btn}
          </Tooltip>
        ) : (
          btn
        );
      })}
    </div>
  );
}
