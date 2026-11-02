import { useRef, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, Columns3, Eraser, FileDown, FileSearch, Pause, Play, Radio, Server, Timer, TriangleAlert, Drama, X } from 'lucide-react';
import { Button, DropdownMenu, IconButton, SearchInput, Spinner, Toolbar, ToolbarSeparator, Tooltip, formatNumber, useElementSize, type MenuItem } from '../../../components';
import { useLanguage, useT, type Lang } from '../../../i18n';
import { METHOD_CHIPS, STATUS_CLASSES, TYPE_CATEGORIES, activeFilterCount, toggleIn, type NetFilters } from '../model/filters';
import { RowCounter } from './NetworkTable';
import { formatShortDuration } from '../../mocks/model/format';

export interface MainToolbarProps {
  query: string;
  onQuery: (q: string) => void;
  invalid: string[];
  searchEnabled: boolean;
  bodySearch: boolean;
  onBodySearch: (on: boolean) => void;
  bodyState: { loading: boolean; error: unknown; count: number | null };
  follow: boolean;
  /** Sorted by a value column: following first switches back to arrival order. */
  followSorted: boolean;
  onFollow: () => void;
  paused: boolean;
  onPause: () => void;
  onClear: () => void;
  clearDisabled: boolean;
  onExportHar: () => void;
  harDisabled: boolean;
  columnItems: () => MenuItem[];
  shown: number;
  total: number;
}

export function MainToolbar(p: MainToolbarProps) {
  const t = useT();
  const bodyBadge: ReactNode = p.bodySearch && p.query.trim() ? (
    p.bodyState.loading ? (
      <Spinner size={11} />
    ) : p.bodyState.error ? (
      <TriangleAlert size={12} className="net-warn-icon" aria-hidden />
    ) : p.bodyState.count !== null ? (
      <span className="tnum">{formatNumber(p.bodyState.count)}</span>
    ) : null
  ) : null;
  return (
    <Toolbar className="net-toolbar" aria-label={t('network.toolbar.label')}>
      <SearchInput
        className="net-search"
        value={p.query}
        onChange={p.onQuery}
        placeholder={t('network.toolbar.searchPlaceholder')}
        aria-label={t('network.toolbar.searchLabel')}
        shortcut={['/', 'Mod+F']}
        shortcutEnabled={p.searchEnabled}
        invalid={p.invalid.length > 0}
        mono
        trailing={
          <Tooltip content={p.bodyState.error ? t('network.toolbar.bodySearchFailed') : t('network.toolbar.bodySearchHint')}>
            <button type="button" className={clsx('net-bodytoggle', p.bodySearch && 'is-on')} aria-pressed={p.bodySearch} onClick={() => p.onBodySearch(!p.bodySearch)}>
              <FileSearch size={13} aria-hidden />
              <span>{t('network.toolbar.bodySearch')}</span>
              {bodyBadge}
            </button>
          </Tooltip>
        }
      />
      {p.invalid.length > 0 ? (
        <Tooltip content={t('network.toolbar.invalidTokens', { tokens: p.invalid.join(' ') })}>
          <span className="net-invalid" role="status">
            <TriangleAlert size={13} aria-hidden />
          </span>
        </Tooltip>
      ) : null}
      <ToolbarSeparator />
      <IconButton icon={Radio} label={p.followSorted ? t('network.toolbar.followSorted') : t('network.toolbar.follow')} shortcut="G" active={p.follow} onClick={p.onFollow} />
      <IconButton icon={p.paused ? Play : Pause} label={p.paused ? t('network.toolbar.resume') : t('network.toolbar.pause')} shortcut="Space" active={p.paused} onClick={p.onPause} />
      <IconButton icon={Eraser} label={t('network.toolbar.clear')} shortcut="Mod+Backspace" onClick={p.onClear} disabled={p.clearDisabled} />
      <IconButton icon={FileDown} label={t('network.toolbar.exportHar', { count: p.shown })} onClick={p.onExportHar} disabled={p.harDisabled} />
      <DropdownMenu items={p.columnItems} aria-label={t('network.toolbar.columns')}>
        {(tp) => <IconButton icon={Columns3} label={t('network.toolbar.columns')} {...tp} />}
      </DropdownMenu>
      <RowCounter shown={p.shown} total={p.total} />
    </Toolbar>
  );
}

const SLOW_PRESETS = [300, 500, 1000, 2000, 3000, 5000];
const formatThreshold = (ms: number, lang: Lang) => formatShortDuration(ms, lang);

function FilterChip({ active, onClick, children, tone, title }: { active: boolean; onClick: () => void; children: ReactNode; tone?: string; title?: string }) {
  return (
    <button type="button" className={clsx('net-fchip', active && 'is-on', tone && `net-fchip--${tone}`)} aria-pressed={active} onClick={onClick} title={title}>
      {children}
    </button>
  );
}

export interface FilterBarProps {
  filters: NetFilters;
  onChange: (patch: Partial<NetFilters>) => void;
  onReset: () => void;
  hostItems: () => MenuItem[];
  hasQuery: boolean;
  onClearQuery: () => void;
}

/** Below this width the content-type chips collapse into a menu (keeps the bar to two calm lines). */
const COMPACT_TYPES_BELOW = 1080;

export function FilterBar({ filters, onChange, onReset, hostItems, hasQuery, onClearQuery }: FilterBarProps) {
  const t = useT();
  const lang = useLanguage();
  const count = activeFilterCount(filters);
  const barRef = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(barRef);
  const compactTypes = width > 0 && width < COMPACT_TYPES_BELOW;
  const typeItems = (): MenuItem[] => [
    { type: 'label', label: t('network.filters.types') },
    ...TYPE_CATEGORIES.map((c): MenuItem => ({ label: t(`network.filters.typeNames.${c}`), checked: filters.types.includes(c), keepOpen: true, onSelect: () => onChange({ types: toggleIn(filters.types, c) }) })),
  ];
  const typeSummary =
    filters.types.length === 0
      ? t('network.filters.allTypes')
      : filters.types.length === 1
        ? t(`network.filters.typeNames.${filters.types[0]}`)
        : t('network.filters.typesCount', { count: filters.types.length });
  const slowItems = (): MenuItem[] => [
    { type: 'label', label: t('network.filters.slowThreshold') },
    ...SLOW_PRESETS.map((ms): MenuItem => ({ label: formatThreshold(ms, lang), checked: filters.slowMs === ms, onSelect: () => onChange({ slowMs: ms, slowOnly: true }) })),
  ];
  return (
    <div ref={barRef} className="net-filterbar" role="toolbar" aria-label={t('network.filters.label')}>
      <div className="net-fgroup" role="group" aria-label={t('network.filters.methods')}>
        {METHOD_CHIPS.map((m) => (
          <FilterChip key={m} active={filters.methods.includes(m)} onClick={() => onChange({ methods: toggleIn(filters.methods, m) })} tone={`m-${m.toLowerCase()}`}>
            {m === 'OTHER' ? t('network.filters.otherMethod') : m}
          </FilterChip>
        ))}
      </div>
      <span className="net-fsep" aria-hidden />
      <div className="net-fgroup" role="group" aria-label={t('network.filters.statuses')}>
        {STATUS_CLASSES.map((s) => (
          <FilterChip key={s} active={filters.statuses.includes(s)} onClick={() => onChange({ statuses: toggleIn(filters.statuses, s) })} tone={`st-${s}`} title={t(`network.filters.statusHint.${s}`)}>
            {s === 'fail' ? t('network.filters.fail') : s}
          </FilterChip>
        ))}
      </div>
      <span className="net-fsep" aria-hidden />
      {compactTypes ? (
        <DropdownMenu items={typeItems} align="start" aria-label={t('network.filters.types')}>
          {(p) => (
            <button type="button" className={clsx('net-fchip net-fchip--menu', filters.types.length > 0 && 'is-on')} {...p}>
              <span className="truncate">{typeSummary}</span>
              <ChevronDown size={12} aria-hidden />
            </button>
          )}
        </DropdownMenu>
      ) : (
        <div className="net-fgroup" role="group" aria-label={t('network.filters.types')}>
          {TYPE_CATEGORIES.map((c) => (
            <FilterChip key={c} active={filters.types.includes(c)} onClick={() => onChange({ types: toggleIn(filters.types, c) })}>
              {t(`network.filters.typeNames.${c}`)}
            </FilterChip>
          ))}
        </div>
      )}
      <span className="net-fsep" aria-hidden />
      <DropdownMenu items={hostItems} align="start" minWidth={260} aria-label={t('network.filters.host')}>
        {(p) => (
          <button type="button" className={clsx('net-fchip net-fchip--menu', filters.host && 'is-on')} {...p}>
            <Server size={12} aria-hidden />
            <span className="truncate net-fchip__host">{filters.host ?? t('network.filters.allHosts')}</span>
            <ChevronDown size={12} aria-hidden />
          </button>
        )}
      </DropdownMenu>
      <span className="net-fsep" aria-hidden />
      <div className="net-fgroup" role="group" aria-label={t('network.filters.toggles')}>
        <FilterChip active={filters.errorsOnly} onClick={() => onChange({ errorsOnly: !filters.errorsOnly })} tone="err">
          <TriangleAlert size={12} aria-hidden />
          {t('network.filters.errorsOnly')}
        </FilterChip>
        <span className="net-fsplit">
          <FilterChip active={filters.slowOnly} onClick={() => onChange({ slowOnly: !filters.slowOnly })} tone="slow" title={t('network.filters.slowHint', { threshold: formatThreshold(filters.slowMs, lang) })}>
            <Timer size={12} aria-hidden />
            {t('network.filters.slow', { threshold: formatThreshold(filters.slowMs, lang) })}
          </FilterChip>
          <DropdownMenu items={slowItems} align="start" aria-label={t('network.filters.slowThreshold')}>
            {(p) => (
              <button type="button" className={clsx('net-fchip net-fchip--caret', filters.slowOnly && 'is-on')} aria-label={t('network.filters.slowThreshold')} {...p}>
                <ChevronDown size={12} aria-hidden />
              </button>
            )}
          </DropdownMenu>
        </span>
        <FilterChip active={filters.mockedOnly} onClick={() => onChange({ mockedOnly: !filters.mockedOnly })} tone="mock">
          <Drama size={12} aria-hidden />
          {t('network.filters.mocked')}
        </FilterChip>
      </div>
      {count > 0 || hasQuery ? (
        <Button
          size="sm"
          variant="ghost"
          icon={X}
          className="net-freset"
          onClick={() => {
            onReset();
            onClearQuery();
          }}
        >
          {t('network.filters.reset')}
          {count > 0 ? <span className="net-seg-count tnum">{count}</span> : null}
        </Button>
      ) : null}
    </div>
  );
}
