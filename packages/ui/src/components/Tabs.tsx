import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import type { IconType } from './Icons';
import { Tooltip } from './Tooltip';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  icon?: IconType;
  /** Rendered after the label (CountBadge, StatusDot…). */
  badge?: ReactNode;
  disabled?: boolean;
  /** Tooltip text. */
  title?: string;
  /** Tooltip shortcut hint. */
  shortcut?: string;
}

export interface TabsProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  items: readonly TabItem<T>[];
  /** 'pill' (top bar) or 'underline' (panels). */
  variant?: 'pill' | 'underline';
  size?: 'sm' | 'md';
  /** Prefix for tab/panel ids: tab → `${idPrefix}-tab-${value}`, panel → `${idPrefix}-panel-${value}`. */
  idPrefix?: string;
  'aria-label'?: string;
  className?: string;
}

/** Accessible tab list (←/→/Home/End move focus and select). Render the panel yourself. */
export function Tabs<T extends string>({ value, onChange, items, variant = 'underline', size = 'md', idPrefix, className, ...aria }: TabsProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const enabled = items.filter((i) => !i.disabled);
    const idx = enabled.findIndex((i) => i.value === value);
    let next = idx;
    if (e.key === 'ArrowLeft') next = (idx - 1 + enabled.length) % enabled.length;
    if (e.key === 'ArrowRight') next = (idx + 1) % enabled.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = enabled.length - 1;
    const item = enabled[next];
    if (!item) return;
    onChange(item.value);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(item.value)}"]`)?.focus());
  };
  return (
    <div ref={ref} role="tablist" aria-label={aria['aria-label']} className={clsx('tabs', `tabs--${variant}`, `tabs--${size}`, className)} onKeyDown={onKeyDown}>
      {items.map((item) => {
        const selected = item.value === value;
        const Icon = item.icon;
        const tab = (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${item.value}` : undefined}
            aria-controls={idPrefix ? `${idPrefix}-panel-${item.value}` : undefined}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            data-value={item.value}
            className={clsx('tab', selected && 'is-selected')}
            onClick={() => onChange(item.value)}
          >
            {Icon ? <Icon size={size === 'sm' ? 14 : 15} aria-hidden /> : null}
            <span className="tab__label">{item.label}</span>
            {item.badge}
          </button>
        );
        return item.title || item.shortcut ? (
          <Tooltip key={item.value} content={item.title} shortcut={item.shortcut}>
            {tab}
          </Tooltip>
        ) : (
          tab
        );
      })}
    </div>
  );
}
