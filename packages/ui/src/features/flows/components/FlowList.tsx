import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, CircleAlert, Copy, Ellipsis, FileDown, FileUp, ListPlus, Play, Plus, Share2, Sparkles, Trash, Workflow, Zap } from 'lucide-react';
import type { FlowSummary } from '@durbun/protocol';
import { Button, DropdownMenu, EmptyState, Highlight, SearchInput, Spinner, StatusDot, Tooltip, formatRelative, openContextMenu, type MenuItem, type Tone } from '../../../components';
import { useFlows } from '../../../data';
import { useT } from '../../../i18n';
import { transfer } from '../../transfer/store';

export type NewFlowKind = 'blank' | 'requests' | 'ai' | 'import';

export interface FlowListProps {
  summaries: FlowSummary[];
  loaded: boolean;
  selectedId: string | null;
  active: boolean;
  onOpen(id: string): void;
  onNew(kind: NewFlowKind): void;
  onRun(id: string): void;
  onDuplicate(id: string): void;
  onExport(id: string): void;
  onAi(id: string): void;
  onDelete(id: string): void;
}

const RUN_TONE: Record<string, Tone> = { passed: 'success', failed: 'danger', cancelled: 'neutral', running: 'accent' };

export function newFlowMenu(t: ReturnType<typeof useT>, onNew: (kind: NewFlowKind) => void): MenuItem[] {
  return [
    { label: t('flows.new.blank'), icon: Plus, description: t('flows.new.blankHint'), onSelect: () => onNew('blank') },
    { label: t('flows.new.requests'), icon: ListPlus, description: t('flows.new.requestsHint'), onSelect: () => onNew('requests') },
    { label: t('flows.new.ai'), icon: Sparkles, description: t('flows.new.aiHint'), onSelect: () => onNew('ai') },
    { type: 'separator' },
    { label: t('flows.new.import'), icon: FileUp, description: t('flows.new.importHint'), onSelect: () => onNew('import') },
  ];
}

/** Left column of the Flows tab: every saved flow with its last run, automation and problems. */
export function FlowList({ summaries, loaded, selectedId, active, onOpen, onNew, onRun, onDuplicate, onExport, onAi, onDelete }: FlowListProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  const running = useFlows((s) => {
    const ids = new Set<string>();
    for (const r of Object.values(s.runs)) if (r.status === 'running') ids.add(r.flowId);
    return [...ids].sort().join('\u0001');
  });
  const runningIds = useMemo(() => new Set(running ? running.split('\u0001') : []), [running]);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...summaries].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    if (!q) return sorted;
    return sorted.filter((f) => f.name.toLowerCase().includes(q) || f.id.includes(q) || (f.description ?? '').toLowerCase().includes(q) || (f.tags ?? []).some((x) => x.toLowerCase().includes(q)));
  }, [summaries, query]);
  const callers = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const f of summaries) for (const c of f.calls) m.set(c, [...(m.get(c) ?? []), f.name]);
    return m;
  }, [summaries]);

  const itemMenu = (f: FlowSummary): MenuItem[] => [
    { label: t('flows.list.open'), icon: Workflow, onSelect: () => onOpen(f.id) },
    { label: t('flows.list.run'), icon: Play, onSelect: () => onRun(f.id), disabled: runningIds.has(f.id) },
    { type: 'separator' },
    { label: t('flows.list.duplicate'), icon: Copy, onSelect: () => onDuplicate(f.id) },
    { label: t('flows.list.export'), icon: FileDown, onSelect: () => onExport(f.id) },
    { label: t('flows.list.share'), icon: Share2, onSelect: () => transfer.openExport('share', [f.id]) },
    { label: t('flows.list.editWithAi'), icon: Sparkles, onSelect: () => onAi(f.id) },
    { type: 'separator' },
    { label: t('flows.list.delete'), icon: Trash, danger: true, onSelect: () => onDelete(f.id) },
  ];

  // One tab stop for the list (the focused row, else the open flow, else the first); the arrows move between rows.
  const tabStop = (focusId && list.some((f) => f.id === focusId) ? focusId : null) ?? (selectedId && list.some((f) => f.id === selectedId) ? selectedId : list[0]?.id);
  const focusRow = (id: string) => {
    setFocusId(id);
    requestAnimationFrame(() => itemsRef.current?.querySelector<HTMLElement>(`[data-flow-id="${CSS.escape(id)}"]`)?.focus());
  };
  const menuAt = (el: HTMLElement, f: FlowSummary) => {
    const r = el.getBoundingClientRect();
    openContextMenu({ x: r.left + Math.min(r.width, 24), y: r.bottom }, itemMenu(f));
  };
  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, f: FlowSummary, i: number) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(f.id);
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      menuAt(e.currentTarget, f);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : Math.min(list.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)));
      if (list[next]) focusRow(list[next]!.id);
    }
  };

  return (
    <div className="fl-list" aria-label={t('flows.list.label')}>
      <div className="fl-list__head">
        <SearchInput value={query} onChange={setQuery} placeholder={t('flows.list.search')} size="sm" shortcut="Mod+F" shortcutEnabled={active} className="fl-list__search" />
        <DropdownMenu items={() => newFlowMenu(t, onNew)} minWidth={300} aria-label={t('flows.new.title')}>
          {(p) => (
            <Button size="sm" variant="primary" icon={Plus} iconRight={ChevronDown} {...p}>
              {t('flows.new.button')}
            </Button>
          )}
        </DropdownMenu>
      </div>
      <div className="fl-list__items" role="listbox" aria-label={t('flows.list.label')} ref={itemsRef}>
        {!loaded ? (
          <div className="fl-list__loading">
            <Spinner size={16} />
          </div>
        ) : summaries.length === 0 ? (
          <EmptyState size="sm" icon={Workflow} title={t('flows.list.emptyTitle')} description={t('flows.list.emptyHint')} />
        ) : list.length === 0 ? (
          <EmptyState size="sm" title={t('flows.list.noResults')} />
        ) : (
          list.map((f, i) => {
            const isRunning = runningIds.has(f.id);
            const last = f.lastRun;
            const tone: Tone = isRunning ? 'accent' : last ? (RUN_TONE[last.status] ?? 'neutral') : 'neutral';
            const usedBy = callers.get(f.id);
            return (
              <div
                key={f.id}
                role="option"
                aria-selected={f.id === selectedId}
                aria-keyshortcuts="Shift+F10"
                tabIndex={f.id === tabStop ? 0 : -1}
                data-flow-id={f.id}
                className={clsx('fl-list__item', f.id === selectedId && 'is-selected')}
                onClick={() => onOpen(f.id)}
                onFocus={(e) => {
                  if (e.target === e.currentTarget) setFocusId(f.id);
                }}
                onKeyDown={(e) => onRowKey(e, f, i)}
                onContextMenu={(e) => openContextMenu(e, itemMenu(f))}
              >
                <StatusDot
                  tone={tone}
                  pulse={isRunning}
                  className={clsx('fl-list__dot', !last && !isRunning && 'is-never')}
                  title={isRunning ? t('flows.status.running') : last ? `${t(`flows.status.${last.status}`)} · ${formatRelative(last.startedAt)}` : t('flows.list.neverRun')}
                />
                <div className="fl-list__text">
                  <div className="fl-list__name">
                    <Highlight text={f.name} query={query.trim()} />
                  </div>
                  <div className="fl-list__meta">
                    {[t('flows.list.steps', { count: f.nodeCount }), f.updatedAt ? formatRelative(f.updatedAt) : ''].filter(Boolean).join(' · ')}
                  </div>
                  {f.tags?.length ? (
                    <div className="fl-list__tags">
                      {f.tags.slice(0, 4).map((tag) => (
                        <span key={tag} className="fl-tag">
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="fl-list__badges">
                  {f.automation && f.triggers.includes('event') ? (
                    <Tooltip content={t('flows.list.automation')}>
                      <span className="fl-list__badge is-auto">
                        <Zap size={12} aria-label={t('flows.list.automation')} />
                      </span>
                    </Tooltip>
                  ) : null}
                  {f.issues.errors ? (
                    <Tooltip content={t('flows.list.errors', { count: f.issues.errors })}>
                      <span className="fl-list__badge is-error tnum">
                        <CircleAlert size={12} aria-hidden />
                        {f.issues.errors}
                      </span>
                    </Tooltip>
                  ) : null}
                  {usedBy?.length ? (
                    <Tooltip content={t('flows.list.usedBy', { names: usedBy.join(', ') })}>
                      <span className="fl-list__badge">
                        <Workflow size={12} aria-label={t('flows.list.usedBy', { names: usedBy.join(', ') })} />
                      </span>
                    </Tooltip>
                  ) : null}
                </div>
                {/* The row menu for the pointer; the keyboard opens it with Shift+F10 on the row. */}
                <button
                  type="button"
                  className="fl-list__more"
                  tabIndex={-1}
                  aria-hidden
                  title={t('flows.list.actions', { name: f.name })}
                  onClick={(e) => {
                    e.stopPropagation();
                    menuAt(e.currentTarget, f);
                  }}
                >
                  <Ellipsis size={14} aria-hidden />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
