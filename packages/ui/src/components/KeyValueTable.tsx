import { useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { t } from '../i18n/core';
import { CopyButton } from './CopyButton';
import { SearchInput } from './SearchInput';

export interface KeyValueRow {
  key: string;
  value: ReactNode;
  /** Text copied for this row (defaults to `value` when it is a string). */
  copyValue?: string;
  /** Dim the row (e.g. inherited/default values). */
  muted?: boolean;
}

export interface KeyValueTableProps {
  /** Rows or [key, value] pairs (e.g. HTTP headers). Duplicate keys are fine. */
  rows: readonly KeyValueRow[] | readonly (readonly [string, string])[];
  /** Show a filter field (auto when there are more than 8 rows unless false). */
  filterable?: boolean;
  /** Monospace values (default true). */
  mono?: boolean;
  /** Key column width (CSS length, default "minmax(120px, 32%)"). */
  keyWidth?: string;
  emptyText?: ReactNode;
  /** Adds a "copy all" button producing `key: value` lines. */
  copyAll?: boolean;
  onRowContextMenu?: (row: KeyValueRow, e: MouseEvent) => void;
  className?: string;
  'aria-label'?: string;
}

function normalize(rows: KeyValueTableProps['rows']): KeyValueRow[] {
  return rows.map((r) => (Array.isArray(r) ? { key: (r as readonly [string, string])[0], value: (r as readonly [string, string])[1] } : (r as KeyValueRow)));
}

function rowText(r: KeyValueRow): string {
  return r.copyValue ?? (typeof r.value === 'string' || typeof r.value === 'number' ? String(r.value) : '');
}

/** Two-column key/value list with per-row copy and optional filtering. */
export function KeyValueTable({ rows, filterable, mono = true, keyWidth, emptyText, copyAll, onRowContextMenu, className, ...aria }: KeyValueTableProps) {
  const all = useMemo(() => normalize(rows), [rows]);
  const [filter, setFilter] = useState('');
  const showFilter = filterable ?? all.length > 8;
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) => r.key.toLowerCase().includes(q) || rowText(r).toLowerCase().includes(q));
  }, [all, filter]);

  return (
    <div className={clsx('kv', className)}>
      {showFilter || copyAll ? (
        <div className="kv__bar">
          {showFilter ? <SearchInput size="sm" value={filter} onChange={setFilter} placeholder={t('common.filter')} className="kv__filter" /> : <span className="grow" />}
          {copyAll && all.length > 0 ? <CopyButton size="sm" value={() => all.map((r) => `${r.key}: ${rowText(r)}`).join('\n')} label={t('common.copyAll')} /> : null}
        </div>
      ) : null}
      {visible.length === 0 ? (
        <div className="kv__empty">{all.length === 0 ? (emptyText ?? t('common.empty')) : t('common.noMatches')}</div>
      ) : (
        <div className="kv__grid" role="table" aria-label={aria['aria-label']} style={keyWidth ? ({ '--kv-key': keyWidth } as CSSProperties) : undefined}>
          {visible.map((r, i) => {
            const text = rowText(r);
            return (
              <div key={`${r.key}-${i}`} className={clsx('kv__row', r.muted && 'is-muted')} role="row" onContextMenu={onRowContextMenu ? (e) => onRowContextMenu(r, e) : undefined}>
                <div className="kv__key" role="cell" title={r.key}>
                  {r.key}
                </div>
                <div className={clsx('kv__value', mono && 'mono')} role="cell">
                  <span className="kv__text selectable">{r.value}</span>
                  {text ? <CopyButton size="xs" value={text} className="kv__copy" label={t('common.copyValue')} /> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
