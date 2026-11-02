import { useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { t } from '../i18n/core';
import { useShortcut } from '../hooks';
import { Kbd } from './Kbd';

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Global shortcut that focuses the field (e.g. "/" or ["/", "Mod+F"]). Only while `shortcutEnabled`. */
  shortcut?: string | string[];
  shortcutEnabled?: boolean;
  /** Match counter, e.g. { current: 3, total: 12 } → "3/12" with prev/next buttons. */
  matches?: { current: number; total: number };
  onNext?: () => void;
  onPrev?: () => void;
  /** Called on Enter (Shift+Enter → onPrev when matches are shown). */
  onSubmit?: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  size?: 'sm' | 'md';
  mono?: boolean;
  autoFocus?: boolean;
  invalid?: boolean;
  /** Content before the clear button (e.g. option toggles). */
  trailing?: ReactNode;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
  'aria-label'?: string;
}

/**
 * Search field with icon, clear button, optional match counter and focus shortcut.
 * Esc clears the text first, then blurs.
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  shortcut,
  shortcutEnabled = true,
  matches,
  onNext,
  onPrev,
  onSubmit,
  onKeyDown,
  size = 'md',
  mono,
  autoFocus,
  invalid,
  trailing,
  inputRef,
  className,
  ...aria
}: SearchInputProps) {
  const local = useRef<HTMLInputElement | null>(null);
  const setRef = (el: HTMLInputElement | null) => {
    local.current = el;
    if (typeof inputRef === 'function') inputRef(el);
    else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = el;
  };
  useShortcut(
    shortcut ?? [],
    () => {
      local.current?.focus();
      local.current?.select();
    },
    { enabled: Boolean(shortcut) && shortcutEnabled },
  );
  const firstShortcut = typeof shortcut === 'string' ? shortcut : shortcut?.[0];

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') {
      if (value) {
        onChange('');
        e.stopPropagation();
      } else e.currentTarget.blur();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      if (matches && e.shiftKey) onPrev?.();
      else if (matches) onNext?.();
      onSubmit?.(value);
    }
  };

  return (
    <div className={clsx('search', `search--${size}`, invalid && 'is-invalid', className)}>
      <Search size={size === 'sm' ? 13 : 14} className="search__icon" aria-hidden />
      <input
        ref={setRef}
        type="text"
        className={clsx('search__input', mono && 'mono')}
        value={value}
        placeholder={placeholder ?? t('common.search')}
        aria-label={aria['aria-label'] ?? placeholder ?? t('common.search')}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKey}
      />
      {matches && value ? (
        <span className="search__count tnum" aria-live="polite">
          {matches.total === 0 ? '0' : `${matches.current}/${matches.total}`}
        </span>
      ) : null}
      {matches && value ? (
        <>
          <button type="button" className="search__btn" aria-label={t('common.previousMatch')} onClick={onPrev} disabled={!matches.total}>
            <ChevronUp size={13} />
          </button>
          <button type="button" className="search__btn" aria-label={t('common.nextMatch')} onClick={onNext} disabled={!matches.total}>
            <ChevronDown size={13} />
          </button>
        </>
      ) : null}
      {trailing}
      {value ? (
        <button
          type="button"
          className="search__btn"
          aria-label={t('common.clear')}
          onClick={() => {
            onChange('');
            local.current?.focus();
          }}
        >
          <X size={13} />
        </button>
      ) : firstShortcut ? (
        <Kbd combo={firstShortcut} size="sm" className="search__kbd" />
      ) : null}
    </div>
  );
}
