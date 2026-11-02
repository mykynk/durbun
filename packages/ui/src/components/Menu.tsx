import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from 'react';
import { create } from 'zustand';
import { clsx } from 'clsx';
import { Check } from 'lucide-react';
import type { IconType } from './Icons';
import { Kbd } from './Kbd';
import { Popover } from './Popover';
import type { Align, AnchorSource, Side } from './floating';

export interface MenuItem {
  type?: 'item' | 'separator' | 'label';
  id?: string;
  label?: ReactNode;
  icon?: IconType;
  /** Shortcut hint (display only). */
  shortcut?: string;
  /** Right-aligned secondary text. */
  hint?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Renders a check column; true shows ✓. */
  checked?: boolean;
  onSelect?: () => void;
  /** Keep the menu open after selecting (toggles). */
  keepOpen?: boolean;
}

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  anchor: AnchorSource;
  items: readonly MenuItem[];
  side?: Side;
  align?: Align;
  minWidth?: number;
  'aria-label'?: string;
  className?: string;
}

const isActionable = (i: MenuItem) => (i.type ?? 'item') === 'item' && !i.disabled;

/** Keyboard-navigable menu (↑/↓, Home/End, Enter/Space, typeahead, Esc). */
export function Menu({ open, onClose, anchor, items, side = 'bottom', align = 'start', minWidth = 200, className, ...aria }: MenuProps) {
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} side={side} align={align} role="menu" aria-label={aria['aria-label']} className={clsx('menu', className)} autoFocus>
      <MenuList items={items} onClose={onClose} minWidth={minWidth} />
    </Popover>
  );
}

function MenuList({ items, onClose, minWidth }: { items: readonly MenuItem[]; onClose: () => void; minWidth: number }) {
  const [active, setActive] = useState(() => items.findIndex(isActionable));
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: '', at: 0 });

  useEffect(() => {
    listRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const move = (dir: 1 | -1) => {
    if (!items.some(isActionable)) return;
    let i = active;
    for (let n = 0; n < items.length; n++) {
      i = (i + dir + items.length) % items.length;
      if (isActionable(items[i]!)) {
        setActive(i);
        return;
      }
    }
  };

  const select = (i: number) => {
    const item = items[i];
    if (!item || !isActionable(item)) return;
    if (!item.keepOpen) onClose();
    item.onSelect?.();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(items.findIndex(isActionable));
    } else if (e.key === 'End') {
      e.preventDefault();
      for (let i = items.length - 1; i >= 0; i--)
        if (isActionable(items[i]!)) {
          setActive(i);
          break;
        }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(active);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onClose();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      const ta = typeahead.current;
      ta.text = now - ta.at < 700 ? ta.text + e.key.toLowerCase() : e.key.toLowerCase();
      ta.at = now;
      const idx = items.findIndex((it, i) => isActionable(it) && i !== -1 && typeof it.label === 'string' && it.label.toLowerCase().startsWith(ta.text));
      if (idx >= 0) setActive(idx);
    }
  };

  const hasChecks = items.some((i) => i.checked !== undefined);

  return (
    <div
      ref={listRef}
      className="menu__list"
      style={{ minWidth }}
      tabIndex={-1}
      aria-activedescendant={active >= 0 ? `menu-item-${active}` : undefined}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) => {
        const type = item.type ?? 'item';
        if (type === 'separator') return <div key={`sep-${i}`} className="menu__sep" role="separator" />;
        if (type === 'label')
          return (
            <div key={`label-${i}`} className="menu__label">
              {item.label}
            </div>
          );
        const Icon = item.icon;
        return (
          <div
            key={item.id ?? i}
            id={`menu-item-${i}`}
            data-index={i}
            role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={item.checked}
            aria-disabled={item.disabled || undefined}
            className={clsx('menu__item', i === active && 'is-active', item.danger && 'menu__item--danger', item.disabled && 'is-disabled')}
            onPointerMove={() => {
              if (isActionable(item) && active !== i) setActive(i);
            }}
            onClick={() => select(i)}
          >
            {hasChecks ? <span className="menu__check">{item.checked ? <Check size={13} aria-hidden /> : null}</span> : null}
            {Icon ? <Icon size={14} className="menu__icon" aria-hidden /> : null}
            <span className="menu__text">{item.label}</span>
            {item.hint ? <span className="menu__hint">{item.hint}</span> : null}
            {item.shortcut ? <Kbd combo={item.shortcut} size="sm" className="menu__kbd" /> : null}
          </div>
        );
      })}
    </div>
  );
}

/* ───────────── DropdownMenu ───────────── */

export interface MenuTriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
}

/**
 * Menu opened by a trigger you render:
 *   <DropdownMenu items={items}>{(p) => <IconButton icon={Ellipsis} label={t('common.more')} {...p} />}</DropdownMenu>
 * `items` may be a function (evaluated on open).
 */
export function DropdownMenu({
  items,
  children,
  side = 'bottom',
  align = 'end',
  minWidth,
  'aria-label': ariaLabel,
}: {
  items: readonly MenuItem[] | (() => readonly MenuItem[]);
  children: (trigger: MenuTriggerProps) => ReactElement;
  side?: Side;
  align?: Align;
  minWidth?: number;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement | null>(null);
  const resolved = open ? (typeof items === 'function' ? items() : items) : [];
  return (
    <>
      {children({ ref, onClick: () => setOpen((o) => !o), 'aria-haspopup': 'menu', 'aria-expanded': open })}
      <Menu
        open={open}
        onClose={() => {
          setOpen(false);
          ref.current?.focus({ preventScroll: true });
        }}
        anchor={ref}
        items={resolved}
        side={side}
        align={align}
        minWidth={minWidth}
        aria-label={ariaLabel}
      />
    </>
  );
}

/* ───────────── Context menu (imperative) ───────────── */

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  items: readonly MenuItem[];
}

const useContextMenuStore = create<ContextMenuState>()(() => ({ open: false, x: 0, y: 0, items: [] }));

/**
 * Open a context menu at the pointer: `onContextMenu={(e) => openContextMenu(e, items)}`.
 * Cheap for virtualized rows (one shared menu instance).
 */
export function openContextMenu(at: { clientX: number; clientY: number; preventDefault?: () => void } | { x: number; y: number }, items: readonly MenuItem[]): void {
  if ('clientX' in at) {
    at.preventDefault?.();
    useContextMenuStore.setState({ open: true, x: at.clientX, y: at.clientY, items });
  } else useContextMenuStore.setState({ open: true, x: at.x, y: at.y, items });
}

export function closeContextMenu(): void {
  useContextMenuStore.setState({ open: false });
}

/** Mount once (App). */
export function ContextMenuHost() {
  const { open, x, y, items } = useContextMenuStore();
  return <Menu open={open} onClose={closeContextMenu} anchor={{ x, y }} items={items} side="bottom" align="start" />;
}
