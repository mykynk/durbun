import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { ChevronDown } from 'lucide-react';
import type { IconType } from './Icons';

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Label and control on one row (label left). */
  inline?: boolean;
  /** id of the control (auto when the child uses `useFieldId`). */
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

/** Label + control + hint/error. */
export function Field({ label, hint, error, inline, htmlFor, children, className }: FieldProps) {
  return (
    <div className={clsx('field', inline && 'field--inline', error ? 'has-error' : undefined, className)}>
      {label ? (
        <label className="field__label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : null}
      <div className="field__control">
        {children}
        {error ? (
          <div className="field__error" role="alert">
            {error}
          </div>
        ) : hint ? (
          <div className="field__hint">{hint}</div>
        ) : null}
      </div>
    </div>
  );
}

export function useFieldId(id?: string): string {
  const auto = useId();
  return id ?? auto;
}

export interface InputProps extends Omit<ComponentPropsWithRef<'input'>, 'size'> {
  size?: 'sm' | 'md';
  mono?: boolean;
  icon?: IconType;
  /** Element rendered inside the right edge (unit, button…). */
  trailing?: ReactNode;
  invalid?: boolean;
  wrapperClassName?: string;
}

export function Input({ size = 'md', mono, icon: Icon, trailing, invalid, className, wrapperClassName, ...rest }: InputProps) {
  if (!Icon && !trailing) {
    return <input className={clsx('input', `input--${size}`, mono && 'mono', invalid && 'is-invalid', className)} aria-invalid={invalid || undefined} {...rest} />;
  }
  return (
    <div className={clsx('input-wrap', `input--${size}`, invalid && 'is-invalid', wrapperClassName)}>
      {Icon ? <Icon size={size === 'sm' ? 13 : 14} className="input-wrap__icon" aria-hidden /> : null}
      <input className={clsx('input', 'input--bare', `input--${size}`, mono && 'mono', className)} aria-invalid={invalid || undefined} {...rest} />
      {trailing ? <div className="input-wrap__trailing">{trailing}</div> : null}
    </div>
  );
}

export interface SelectProps extends Omit<ComponentPropsWithRef<'select'>, 'size'> {
  size?: 'sm' | 'md';
  options?: readonly { value: string; label: string; disabled?: boolean }[];
}

/** Native select (keyboard/a11y for free) styled to match. */
export function Select({ size = 'md', options, className, children, ...rest }: SelectProps) {
  return (
    <div className={clsx('select-wrap', `select--${size}`, className)}>
      <select className="select" {...rest}>
        {options
          ? options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))
          : children}
      </select>
      <ChevronDown size={14} className="select-wrap__chevron" aria-hidden />
    </div>
  );
}

export interface TextareaProps extends ComponentPropsWithRef<'textarea'> {
  mono?: boolean;
  invalid?: boolean;
}

export function Textarea({ mono, invalid, className, ...rest }: TextareaProps) {
  return <textarea className={clsx('textarea', mono && 'mono', invalid && 'is-invalid', className)} aria-invalid={invalid || undefined} {...rest} />;
}
