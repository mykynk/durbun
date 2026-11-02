import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, Link2 } from 'lucide-react';
import {
  ROOT_KEY,
  childCount,
  childKey,
  collectContainerKeys,
  entriesOf,
  isContainer,
  jsonPath,
  keysToDepth,
  previewValue,
  searchJson,
  valueToText,
  type PathSegment,
} from '../lib/json';
import { copyText } from '../lib/clipboard';
import { isMac } from '../lib/platform';
import { t } from '../i18n/core';
import { Highlight } from './Highlight';
import { IconButton } from './Button';
import { SearchInput } from './SearchInput';
import { CopyButton } from './CopyButton';
import { openContextMenu } from './Menu';
import { toast } from './Toast';

export interface JsonTreeProps {
  data: unknown;
  /** Root name used in copied paths (default "data" → `data.items[0].id`). */
  rootLabel?: string;
  /** Container depth expanded initially (default 1: top-level children visible). */
  defaultExpandDepth?: number;
  /** Controlled search text (highlights matches and expands their ancestors). */
  search?: string;
  /** Show a toolbar with search, expand/collapse all and copy (default false). */
  toolbar?: boolean;
  /** Children rendered per container before "show more" (default 100). */
  pageSize?: number;
  /** Strings longer than this are truncated with an expander (default 300). */
  maxStringLength?: number;
  className?: string;
  'aria-label'?: string;
}

interface TreeCtx {
  rootLabel: string;
  expanded: ReadonlySet<string>;
  toggle: (key: string, open?: boolean) => void;
  pages: ReadonlyMap<string, number>;
  showMore: (key: string) => void;
  pageSize: number;
  query: string;
  matches: ReadonlySet<string>;
  fullStrings: ReadonlySet<string>;
  showFull: (key: string) => void;
  maxStringLength: number;
  activeKey: string | null;
  setActive: (key: string) => void;
}

const Ctx = createContext<TreeCtx | null>(null);

function parentKeyOf(key: string): string | null {
  let idx = -1;
  for (let i = key.length - 1; i >= 0; i--) {
    const c = key.charCodeAt(i);
    if (c === 2 || c === 3) {
      idx = i;
      break;
    }
  }
  return idx > 0 ? key.slice(0, idx) : null;
}

/**
 * Lazy JSON tree: children render only when expanded, large containers are paged, search highlights
 * matches and expands their ancestors. Right-click a row (or hover) to copy the value or its path.
 * Keyboard: ↑/↓ move, →/← expand/collapse, Enter toggles, Mod+C copies the value.
 */
export function JsonTree({
  data,
  rootLabel = 'data',
  defaultExpandDepth = 1,
  search,
  toolbar = false,
  pageSize = 100,
  maxStringLength = 300,
  className,
  ...aria
}: JsonTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => keysToDepth(data, defaultExpandDepth));
  const [pages, setPages] = useState<Map<string, number>>(() => new Map());
  const [fullStrings, setFullStrings] = useState<Set<string>>(() => new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [localSearch, setLocalSearch] = useState('');
  const [truncatedExpand, setTruncatedExpand] = useState(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const query = search ?? localSearch;

  // New data → fresh state.
  const dataRef = useRef(data);
  useEffect(() => {
    if (dataRef.current === data) return;
    dataRef.current = data;
    setExpanded(keysToDepth(data, defaultExpandDepth));
    setPages(new Map());
    setFullStrings(new Set());
    setActiveKey(null);
    setTruncatedExpand(false);
  }, [data, defaultExpandDepth]);

  const searchResult = useMemo(() => searchJson(data, query), [data, query]);
  useEffect(() => {
    if (searchResult.expand.size === 0) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const k of searchResult.expand) {
        if (!next.has(k)) {
          next.add(k);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [searchResult]);

  const toggle = useCallback((key: string, open?: boolean) => {
    setExpanded((prev) => {
      const isOpen = prev.has(key);
      const want = open ?? !isOpen;
      if (want === isOpen) return prev;
      const next = new Set(prev);
      if (want) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const showMore = useCallback(
    (key: string) =>
      setPages((prev) => {
        const next = new Map(prev);
        next.set(key, (prev.get(key) ?? pageSize) + pageSize * 5);
        return next;
      }),
    [pageSize],
  );
  const showFull = useCallback((key: string) => setFullStrings((prev) => new Set(prev).add(key)), []);

  const expandAll = () => {
    const { keys, truncated } = collectContainerKeys(data, 5000);
    setExpanded(keys);
    setTruncatedExpand(truncated);
  };
  const collapseAll = () => {
    setExpanded(new Set([ROOT_KEY]));
    setTruncatedExpand(false);
  };

  const ctx = useMemo<TreeCtx>(
    () => ({
      rootLabel,
      expanded,
      toggle,
      pages,
      showMore,
      pageSize,
      query,
      matches: searchResult.matches,
      fullStrings,
      showFull,
      maxStringLength,
      activeKey,
      setActive: setActiveKey,
    }),
    [rootLabel, expanded, toggle, pages, showMore, pageSize, query, searchResult.matches, fullStrings, showFull, maxStringLength, activeKey],
  );

  const rows = () => [...(treeRef.current?.querySelectorAll<HTMLElement>('[data-jt-key]') ?? [])];
  const focusRow = (key: string) => {
    setActiveKey(key);
    requestAnimationFrame(() => {
      const el = treeRef.current?.querySelector<HTMLElement>(`[data-jt-key="${CSS.escape(key)}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = rows();
    if (list.length === 0) return;
    const keys = list.map((r) => r.dataset.jtKey!);
    const idx = activeKey ? keys.indexOf(activeKey) : -1;
    const cur = idx >= 0 ? list[idx]! : null;
    const isOpenable = cur?.dataset.jtContainer === '1';
    const isOpen = cur?.getAttribute('aria-expanded') === 'true';
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusRow(keys[Math.min(keys.length - 1, idx + 1)]!);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusRow(keys[Math.max(0, idx - 1)]!);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusRow(keys[0]!);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusRow(keys[keys.length - 1]!);
    } else if (e.key === 'ArrowRight' && cur) {
      e.preventDefault();
      if (isOpenable && !isOpen) toggle(activeKey!, true);
      else if (idx + 1 < keys.length) focusRow(keys[idx + 1]!);
    } else if (e.key === 'ArrowLeft' && cur) {
      e.preventDefault();
      if (isOpenable && isOpen) toggle(activeKey!, false);
      else {
        const parent = parentKeyOf(activeKey!);
        if (parent && keys.includes(parent)) focusRow(parent);
      }
    } else if ((e.key === 'Enter' || e.key === ' ') && cur && isOpenable) {
      e.preventDefault();
      toggle(activeKey!);
    } else if (mod && e.key.toLowerCase() === 'c' && cur && !window.getSelection()?.toString()) {
      e.preventDefault();
      cur.dispatchEvent(new CustomEvent('jt-copy', { bubbles: false }));
    }
  };

  const rootIsContainer = isContainer(data);

  return (
    <div className={clsx('jt', className)}>
      {toolbar ? (
        <div className="jt__toolbar">
          {search === undefined ? <SearchInput size="sm" value={localSearch} onChange={setLocalSearch} placeholder={t('common.json.search')} className="jt__search" /> : null}
          {query ? (
            <span className="jt__count tnum">{searchResult.truncated ? t('common.json.matchesMany', { count: searchResult.count }) : t('common.json.matches', { count: searchResult.count })}</span>
          ) : null}
          <span className="grow" />
          {truncatedExpand ? <span className="jt__note">{t('common.json.expandLimited')}</span> : null}
          <IconButton icon={ChevronsUpDown} label={t('common.json.expandAll')} size="sm" onClick={expandAll} disabled={!rootIsContainer} />
          <IconButton icon={ChevronsDownUp} label={t('common.json.collapseAll')} size="sm" onClick={collapseAll} disabled={!rootIsContainer} />
          <CopyButton size="sm" value={() => valueToText(data)} label={t('common.json.copyAll')} />
        </div>
      ) : null}
      <div
        ref={treeRef}
        role="tree"
        aria-label={aria['aria-label'] ?? 'JSON'}
        tabIndex={0}
        className="jt__tree mono selectable"
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          if (e.target === e.currentTarget && !activeKey) {
            const first = rows()[0]?.dataset.jtKey;
            if (first) setActiveKey(first);
          }
        }}
      >
        <Ctx.Provider value={ctx}>
          {rootIsContainer ? (
            <Children value={data as Record<string, unknown> | unknown[]} parentKey={ROOT_KEY} segs={[]} depth={0} />
          ) : (
            <JsonNode label={null} value={data} nodeKey={ROOT_KEY} segs={[]} depth={0} />
          )}
        </Ctx.Provider>
      </div>
    </div>
  );
}

const Children = memo(function Children({
  value,
  parentKey,
  segs,
  depth,
}: {
  value: Record<string, unknown> | unknown[];
  parentKey: string;
  segs: readonly PathSegment[];
  depth: number;
}) {
  const ctx = useContext(Ctx)!;
  const entries = useMemo(() => entriesOf(value), [value]);
  const limit = ctx.pages.get(parentKey) ?? ctx.pageSize;
  const shown = entries.length > limit ? entries.slice(0, limit) : entries;
  return (
    <>
      {shown.map(([seg, child]) => {
        const key = childKey(parentKey, seg);
        return <JsonNode key={key} label={seg} value={child} nodeKey={key} segs={[...segs, seg]} depth={depth} />;
      })}
      {entries.length > limit ? (
        <div className="jt__row jt__more" style={{ paddingLeft: depth * 14 + 22 }}>
          <button type="button" className="jt__more-btn" onClick={() => ctx.showMore(parentKey)}>
            {t('common.json.showMore', { count: Math.min(entries.length - limit, ctx.pageSize * 5), total: entries.length - limit })}
          </button>
        </div>
      ) : null}
    </>
  );
});

function JsonNode({ label, value, nodeKey, segs, depth }: { label: PathSegment | null; value: unknown; nodeKey: string; segs: readonly PathSegment[]; depth: number }) {
  const ctx = useContext(Ctx)!;
  const container = isContainer(value);
  const open = container && ctx.expanded.has(nodeKey);
  return (
    <>
      <JsonRow label={label} value={value} nodeKey={nodeKey} segs={segs} depth={depth} open={open} />
      {open ? <Children value={value as Record<string, unknown> | unknown[]} parentKey={nodeKey} segs={segs} depth={depth + 1} /> : null}
    </>
  );
}

function JsonRow({ label, value, nodeKey, segs, depth, open }: { label: PathSegment | null; value: unknown; nodeKey: string; segs: readonly PathSegment[]; depth: number; open: boolean }) {
  const ctx = useContext(Ctx)!;
  const rowRef = useRef<HTMLDivElement>(null);
  const container = isContainer(value);
  const matched = ctx.matches.has(nodeKey);
  const active = ctx.activeKey === nodeKey;
  const path = () => jsonPath(segs, ctx.rootLabel);

  const copyValue = async () => {
    if (await copyText(valueToText(value))) toast.success(t('common.json.valueCopied'));
  };
  const copyPath = async () => {
    if (await copyText(path())) toast.success(t('common.json.pathCopied'), { description: path() });
  };

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const onCopy = () => void copyValue();
    el.addEventListener('jt-copy', onCopy);
    return () => el.removeEventListener('jt-copy', onCopy);
  });

  const onContextMenu = (e: ReactMouseEvent) => {
    if (window.getSelection()?.toString()) return; // keep the native menu for text selections
    ctx.setActive(nodeKey);
    openContextMenu(e, [
      { label: t('common.json.copyValue'), icon: Copy, onSelect: () => void copyValue() },
      { label: t('common.json.copyPath'), icon: Link2, hint: path(), onSelect: () => void copyPath() },
      ...(typeof label === 'string' ? [{ label: t('common.json.copyKey'), onSelect: () => void copyText(label) }] : []),
      ...(container
        ? [
            { type: 'separator' as const },
            { label: open ? t('common.json.collapse') : t('common.json.expand'), onSelect: () => ctx.toggle(nodeKey) },
          ]
        : []),
    ]);
  };

  let valueNode: ReactNode;
  if (container) {
    const n = childCount(value as Record<string, unknown> | unknown[]);
    const isArr = Array.isArray(value);
    valueNode = open ? (
      <span className="jt__brace">{isArr ? `[${n === 0 ? ']' : ''}` : `{${n === 0 ? '}' : ''}`}</span>
    ) : (
      <span className="jt__preview">{n === 0 ? (isArr ? '[]' : '{}') : previewValue(value)}</span>
    );
    valueNode = (
      <>
        {valueNode}
        {n > 0 ? <span className="jt__count-badge">{isArr ? t('common.json.items', { count: n }) : t('common.json.keys', { count: n })}</span> : null}
      </>
    );
  } else if (typeof value === 'string') {
    const full = ctx.fullStrings.has(nodeKey) || value.length <= ctx.maxStringLength;
    const text = full ? value : value.slice(0, ctx.maxStringLength);
    valueNode = (
      <span className="jt__string">
        "<Highlight text={text} query={ctx.query} />
        {full ? '"' : null}
        {!full ? (
          <button type="button" className="jt__expand-str" onClick={() => ctx.showFull(nodeKey)}>
            …{t('common.json.moreChars', { count: value.length - ctx.maxStringLength })}
          </button>
        ) : null}
      </span>
    );
  } else {
    const cls = value === null ? 'jt__null' : typeof value === 'number' ? 'jt__number' : typeof value === 'boolean' ? 'jt__bool' : 'jt__other';
    valueNode = <Highlight className={cls} text={value === null ? 'null' : String(value)} query={ctx.query} />;
  }

  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={container ? open : undefined}
      aria-selected={active}
      data-jt-key={nodeKey}
      data-jt-container={container ? '1' : '0'}
      className={clsx('jt__row', active && 'is-active', matched && 'is-match')}
      style={{ paddingLeft: depth * 14 + 4 }}
      onClick={(e) => {
        ctx.setActive(nodeKey);
        if (container && !(e.target as HTMLElement).closest('button') && !window.getSelection()?.toString()) ctx.toggle(nodeKey);
      }}
      onContextMenu={onContextMenu}
    >
      <span className="jt__caret" aria-hidden>
        {container ? <ChevronRight size={12} className={clsx(open && 'is-open')} /> : null}
      </span>
      {label !== null ? (
        <>
          {typeof label === 'number' ? (
            <span className="jt__index">{label}</span>
          ) : (
            <span className="jt__key">
              <Highlight text={label} query={ctx.query} />
            </span>
          )}
          <span className="jt__colon">: </span>
        </>
      ) : null}
      <span className="jt__value">{valueNode}</span>
      <span className="jt__actions">
        <button
          type="button"
          className="jt__action"
          title={t('common.json.copyValue')}
          aria-label={t('common.json.copyValue')}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            void copyValue();
          }}
        >
          <Copy size={12} />
        </button>
        <button
          type="button"
          className="jt__action"
          title={`${t('common.json.copyPath')} · ${path()}`}
          aria-label={t('common.json.copyPath')}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            void copyPath();
          }}
        >
          <Link2 size={12} />
        </button>
      </span>
    </div>
  );
}
