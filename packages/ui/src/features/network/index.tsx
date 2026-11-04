import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ArrowLeftRight, BookOpen, Columns3, Copy, Drama, Eraser, FileDown, FilterX, Link2, Pause, PencilLine, Play, Radio, RotateCw, ScrollText, Share2, X } from 'lucide-react';
import type { NetworkEntry, UiCommand } from '@durbun/protocol';
import {
  ALL_SCOPE,
  networkStore,
  onResync,
  onServerMessage,
  scopeNetworkCounts,
  sendCommand,
  setScope,
  ui,
  useCompiledScope,
  useHub,
  useNetworkVersion,
  usePrefs,
  useUi,
} from '../../data';
import {
  Button,
  EmptyState,
  SplitPane,
  formatDuration,
  formatNumber,
  isMac,
  openContextMenu,
  toast,
  useCommands,
  useEvent,
  useFeatureActive,
  usePersistentState,
  useShortcut,
  type MenuItem,
} from '../../components';
import { errorText, useLanguage, useT } from '../../i18n';
import { NetRowIndex } from './model/rows';
import { DEFAULT_FILTERS, compileFilter, parseQuery, sanitizeFilters, type NetFilters } from './model/filters';
import {
  COLUMNS,
  DEFAULT_COLUMN_PREFS,
  DEFAULT_SORT,
  isChronological,
  nextSort,
  sanitizeColumnPrefs,
  sanitizeSort,
  sortEntries,
  visibleColumns,
  type ColumnId,
  type ColumnPrefs,
  type SortKey,
  type SortState,
} from './model/columns';
import { COPY_FORMATS } from './model/copyAs';
import { NetworkTable, type RevealRequest } from './components/NetworkTable';
import { FilterBar, MainToolbar } from './components/Toolbars';
import { DetailPanel } from './components/DetailPanel';
import { ReplayDialog } from './components/ReplayDialog';
import { CompareDialog } from './components/CompareDialog';
import { ShareDialog } from './components/ShareDialog';
import { copyEntryAs, copyUrl, createMockFrom, downloadHarFor, harFileName, replayRequest, showInLogs } from './actions';
import { useBodySearch } from './useBodySearch';
import { ExplainEmpty } from '../../sources';
import './i18n';
import './network.css';

/** Network tab ("Ağ"): live request table, filters, detail, replay, compare, HAR, mocks from requests. */
export default function NetworkView() {
  const t = useT();
  const lang = useLanguage();
  const active = useFeatureActive();
  const compiled = useCompiledScope();
  // `useCompiledScope` returns a new object whenever any app's stats change (every batch); the row
  // index must only rebuild when the scope's MEMBERSHIP changes, so key it on what the predicate uses.
  const scopeKey =
    compiled.scope.kind === 'all'
      ? 'all'
      : compiled.scope.kind === 'device'
        ? `d:${compiled.scope.deviceId}`
        : `a:${compiled.deviceId ?? ''}|${compiled.bundleId ?? ''}:${[...(compiled.appIds ?? [])].sort().join(',')}`;
  const inScope = useMemo(() => compiled.network, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const noNetworkCapability = useHub((s) => {
    const ids = compiled.appIds;
    if (!ids || ids.size === 0) return false;
    let any = false;
    for (const id of ids) {
      const a = s.apps[id];
      if (!a) continue;
      any = true;
      if (a.capabilities.includes('network')) return false;
    }
    return any;
  });
  const density = usePrefs((s) => s.density);
  const rowHeight = density === 'comfortable' ? 26 : 22;

  /* ── persisted view state ── */
  const [rawFilters, setRawFilters] = usePersistentState<NetFilters>('network.filters', DEFAULT_FILTERS);
  const filters = useMemo(() => sanitizeFilters(rawFilters), [rawFilters]);
  const patchFilters = useCallback((patch: Partial<NetFilters>) => setRawFilters((f) => ({ ...sanitizeFilters(f), ...patch })), [setRawFilters]);
  const resetFilters = useCallback(() => setRawFilters((f) => ({ ...DEFAULT_FILTERS, slowMs: sanitizeFilters(f).slowMs })), [setRawFilters]);
  const [rawSort, setRawSort] = usePersistentState<SortState>('network.sort', DEFAULT_SORT);
  const sort = useMemo(() => sanitizeSort(rawSort), [rawSort]);
  const [rawCols, setRawCols] = usePersistentState<ColumnPrefs>('network.columns', DEFAULT_COLUMN_PREFS);
  const colPrefs = useMemo(() => sanitizeColumnPrefs(rawCols), [rawCols]);
  const columns = useMemo(() => visibleColumns(colPrefs), [colPrefs]);
  const [bodySearch, setBodySearch] = usePersistentState('network.bodySearch', false);
  const [query, setQuery] = useState('');
  const parsed = useMemo(() => parseQuery(query), [query]);
  const serverText = bodySearch ? parsed.freeText : '';
  const body = useBodySearch(serverText, active);

  /* ── selection & live behavior ── */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, setFollowState] = useState(true);
  const [paused, setPaused] = useState(false);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const revealSeq = useRef(0);
  const [marks, setMarks] = useState<string[]>([]);
  const [compareBase, setCompareBase] = useState<string | null>(null);
  const [comparePair, setComparePair] = useState<[NetworkEntry, NetworkEntry] | null>(null);
  const [replayEntry, setReplayEntry] = useState<NetworkEntry | null>(null);
  const [shareEntry, setShareEntry] = useState<NetworkEntry | null>(null);
  /** Entry returned by a replay before the store has it. */
  const [fallbackEntry, setFallbackEntry] = useState<NetworkEntry | null>(null);
  const dialogOpen = !!comparePair || !!replayEntry || !!shareEntry;

  /* ── rows ── */
  const chronological = isChronological(sort);
  const v = useNetworkVersion({ enabled: active, throttleMs: chronological ? 0 : 300 });
  const index = useMemo(() => new NetRowIndex(), []);
  useEffect(
    () =>
      onServerMessage((m) => {
        if (m.type === 'batch' && m.network?.length) index.markDirty(m.network.map((e) => e.id));
      }),
    [index],
  );
  useEffect(() => onResync(() => index.invalidate()), [index]);

  // Read at call time: an app's name and bundle id never change, so this needs no subscription.
  const appLabel = useCallback((appId: string | undefined) => {
    const a = appId ? useHub.getState().apps[appId] : undefined;
    return a ? `${a.app.name} ${a.app.id}` : (appId ?? '');
  }, []);
  const predicate = useMemo(() => {
    const f = compileFilter(filters, parsed, { slowMs: filters.slowMs, bodyMatches: serverText ? body.matches : null, appLabel });
    return (e: NetworkEntry) => inScope(e) && f(e);
  }, [filters, parsed, serverText, body.matches, appLabel, inScope]);

  const frozen = useRef<{ ids: readonly string[]; predicate: unknown; total: number; generation: number } | null>(null);
  const ids = useMemo(() => {
    const fz = frozen.current;
    if (paused && fz && fz.predicate === predicate) {
      // Paused: the list keeps its composition, but cleared / evicted requests still disappear.
      if (fz.generation !== networkStore.generation) {
        fz.ids = fz.ids.filter((id) => networkStore.byId.has(id));
        fz.generation = networkStore.generation;
      }
      return fz.ids;
    }
    index.sync(networkStore, predicate);
    frozen.current = { ids: index.ids, predicate, total: paused && fz ? fz.total : networkStore.totalReceived, generation: networkStore.generation };
    return index.ids;
    // `v` re-runs the sync on store changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, predicate, paused, index]);
  if (!paused && frozen.current) frozen.current.total = networkStore.totalReceived;
  const waiting = paused && frozen.current ? Math.max(0, networkStore.totalReceived - frozen.current.total) : 0;

  const rowIds = useMemo(() => {
    if (sort.key === 'seq') return sort.dir === 'asc' ? ids : ids.slice().reverse();
    const list: NetworkEntry[] = [];
    for (const id of ids) {
      const e = networkStore.get(id);
      if (e) list.push(e);
    }
    return sortEntries(list, sort).map((e) => e.id);
    // value sorts re-run on store changes (throttled); arrival order only when the list changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, sort, sort.key === 'seq' ? 0 : v]);

  const scopeTotal = useMemo(() => scopeNetworkCounts(compiled, networkStore).total, [scopeKey, v]); // eslint-disable-line react-hooks/exhaustive-deps

  const followEdge: 'bottom' | 'top' | null = chronological ? (sort.dir === 'asc' ? 'bottom' : 'top') : null;
  const followMark = useRef(0);
  const setFollow = useCallback(
    (on: boolean) => {
      setFollowState(on);
      if (!on) followMark.current = index.appended;
    },
    [index],
  );
  const newCount = follow ? 0 : Math.max(0, index.appended - followMark.current);

  /* ── selected entry ── */
  const storeSelected = selectedId ? networkStore.get(selectedId) : undefined;
  const lastSelected = useRef<NetworkEntry | null>(null);
  if (storeSelected) lastSelected.current = storeSelected;
  else if (selectedId && fallbackEntry?.id === selectedId) lastSelected.current = fallbackEntry;
  const selected = selectedId ? (storeSelected ?? (lastSelected.current?.id === selectedId ? lastSelected.current : null)) : null;
  const gone = !!selectedId && !storeSelected && fallbackEntry?.id !== selectedId;

  const select = useCallback(
    (id: string | null, opts: { reveal?: boolean; center?: boolean } = {}) => {
      setSelectedId(id);
      if (id) {
        setFollow(false);
        if (opts.reveal) setReveal({ id, seq: ++revealSeq.current, center: opts.center });
      }
    },
    [setFollow],
  );

  const openCompare = useCallback(
    (aId: string, bId: string) => {
      const a = networkStore.get(aId);
      const b = networkStore.get(bId);
      if (!a || !b) {
        toast.warn(t('network.compare.unavailable'));
        return;
      }
      setComparePair([a, b]);
    },
    [t],
  );

  const doReplay = useCallback(
    async (e: NetworkEntry) => {
      const res = await replayRequest(e);
      if (res) {
        setFallbackEntry(res);
        select(res.id, { reveal: true });
      }
    },
    [select],
  );

  /* ── row interactions ── */
  const onRowClick = useEvent((id: string, ev: MouseEvent) => {
    if (compareBase) {
      if (id !== compareBase) openCompare(compareBase, id);
      setCompareBase(null);
      return;
    }
    if (isMac ? ev.metaKey : ev.ctrlKey) {
      const next = marks.includes(id) ? marks.filter((x) => x !== id) : [...marks, id].slice(-2);
      setMarks(next);
      if (next.length === 2) openCompare(next[0]!, next[1]!);
      return;
    }
    select(id);
  });

  const rowMenu = (e: NetworkEntry): MenuItem[] => {
    const base = compareBase && compareBase !== e.id ? networkStore.get(compareBase) : undefined;
    return [
      { label: t('network.share.menu'), icon: Share2, onSelect: () => setShareEntry(e) },
      { type: 'separator' },
      { label: t('network.menu.copyUrl'), icon: Link2, onSelect: () => void copyUrl(e) },
      ...COPY_FORMATS.map((f): MenuItem => ({ label: t(`network.menu.copyAs.${f}`), icon: f === 'curl' ? Copy : undefined, onSelect: () => void copyEntryAs(e, f) })),
      { type: 'separator' },
      { label: t('network.menu.replay'), icon: RotateCw, disabled: e.method === '?', onSelect: () => void doReplay(e) },
      { label: t('network.menu.editReplayEllipsis'), icon: PencilLine, disabled: e.method === '?', onSelect: () => setReplayEntry(e) },
      { label: t('network.menu.createMock'), icon: Drama, onSelect: () => void createMockFrom(e) },
      { type: 'separator' },
      { label: t('network.menu.showInLogs'), icon: ScrollText, onSelect: () => showInLogs(e) },
      { label: t('network.menu.har'), icon: FileDown, onSelect: () => void downloadHarFor([e.id], harFileName(e)) },
      base
        ? { label: t('network.menu.compareWith', { name: `${base.method} ${base.path}` }), icon: ArrowLeftRight, onSelect: () => openCompare(base.id, e.id) }
        : { label: t('network.menu.compareEllipsis'), icon: ArrowLeftRight, hint: t('network.menu.compareHint'), onSelect: () => setCompareBase(e.id) },
    ];
  };

  const onRowContextMenu = useEvent((id: string, ev: MouseEvent) => {
    const e = networkStore.get(id);
    if (!e) return;
    openContextMenu(ev, rowMenu(e));
  });

  /* ── toolbar actions ── */
  const clear = async () => {
    const s = compiled.scope;
    const cmds: UiCommand[] = [];
    if (s.kind === 'all') cmds.push({ name: 'clear', target: 'network' });
    else {
      if (s.kind === 'device') cmds.push({ name: 'clear', target: 'network', deviceId: s.deviceId });
      else for (const appId of compiled.appIds ?? []) cmds.push({ name: 'clear', target: 'network', appId });
      cmds.push({ name: 'clear', target: 'network', deviceId: 'desktop' });
    }
    const count = scopeTotal;
    try {
      await Promise.all(cmds.map((c) => sendCommand(c)));
      setSelectedId(null);
      setMarks([]);
      toast.success(t('network.toast.cleared', { count }));
    } catch (err) {
      toast.error(t('network.toast.clearFailed'), { description: errorText(err) });
    }
  };

  const exportHar = () => {
    if (rowIds.length === 0) return;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    void downloadHarFor([...rowIds], `durbun-${stamp}.har`);
    toast.info(t('network.toast.harStarted', { count: rowIds.length }));
  };

  const hostItems = (): MenuItem[] => {
    const counts = new Map<string, number>();
    for (const e of networkStore.list()) {
      if (!compiled.network(e) || !e.host) continue;
      counts.set(e.host, (counts.get(e.host) ?? 0) + 1);
    }
    const hosts = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return [
      { label: t('network.filters.allHosts'), checked: filters.host === null, onSelect: () => patchFilters({ host: null }) },
      ...(hosts.length ? [{ type: 'separator' as const }] : []),
      ...hosts.slice(0, 60).map(([h, n]): MenuItem => ({ label: <span className="mono">{h}</span>, hint: formatNumber(n), checked: filters.host === h, onSelect: () => patchFilters({ host: h }) })),
      ...(filters.host && !counts.has(filters.host) ? [{ label: <span className="mono">{filters.host}</span>, hint: '0', checked: true, onSelect: () => patchFilters({ host: null }) }] : []),
    ];
  };

  const columnItems = (): MenuItem[] => [
    { type: 'label', label: t('network.toolbar.columns') },
    ...COLUMNS.filter((c) => c.hideable).map(
      (c): MenuItem => ({
        label: t(`network.columns.${c.id}`),
        checked: !colPrefs.hidden.includes(c.id),
        keepOpen: true,
        onSelect: () =>
          setRawCols((p) => {
            const cur = sanitizeColumnPrefs(p);
            const hidden = cur.hidden.includes(c.id) ? cur.hidden.filter((x) => x !== c.id) : [...cur.hidden, c.id];
            return { ...cur, hidden };
          }),
      }),
    ),
    { type: 'separator' },
    { label: t('network.toolbar.resetColumns'), icon: Columns3, onSelect: () => setRawCols(DEFAULT_COLUMN_PREFS) },
  ];

  const onResizeColumn = useCallback(
    (id: ColumnId, width: number | undefined) =>
      setRawCols((p) => {
        const cur = sanitizeColumnPrefs(p);
        const widths = { ...cur.widths };
        if (width === undefined) delete widths[id];
        else widths[id] = width;
        return { ...cur, widths };
      }),
    [setRawCols],
  );

  const onSort = useCallback((key: SortKey) => setRawSort((s) => nextSort(sanitizeSort(s), key)), [setRawSort]);

  const togglePause = () => setPaused((p) => !p);
  const jumpToNewest = () => {
    if (!followEdge) {
      setRawSort(DEFAULT_SORT);
    }
    setPaused(false);
    setFollow(true);
  };

  /* ── keyboard ── */
  const kbEnabled = active && !dialogOpen;
  const move = (delta: number) => {
    if (rowIds.length === 0) return;
    let idx = selectedId ? rowIds.indexOf(selectedId) : -1;
    idx = idx < 0 ? (delta > 0 ? 0 : rowIds.length - 1) : Math.max(0, Math.min(rowIds.length - 1, idx + delta));
    select(rowIds[idx]!, { reveal: true });
  };
  useShortcut(['ArrowDown', 'J'], () => move(1), { enabled: kbEnabled, allowRepeat: true });
  useShortcut(['ArrowUp', 'K'], () => move(-1), { enabled: kbEnabled, allowRepeat: true });
  useShortcut(['PageDown'], () => move(10), { enabled: kbEnabled, allowRepeat: true });
  useShortcut(['PageUp'], () => move(-10), { enabled: kbEnabled, allowRepeat: true });
  useShortcut(
    'Enter',
    () => {
      if (!selectedId) {
        move(1);
        return;
      }
      document.querySelector<HTMLElement>('.net-detail [role="tab"][aria-selected="true"]')?.focus();
    },
    { enabled: kbEnabled },
  );
  useShortcut(
    'Escape',
    () => {
      if (compareBase) setCompareBase(null);
      else if (marks.length) setMarks([]);
      else if (selectedId) setSelectedId(null);
      else return false;
    },
    { enabled: kbEnabled },
  );
  useShortcut('Space', togglePause, { enabled: kbEnabled });
  useShortcut('G', jumpToNewest, { enabled: kbEnabled });
  useShortcut('Mod+Backspace', () => void clear(), { enabled: kbEnabled, allowInInputs: false });

  /* ── cross-feature focus ── */
  const focus = useUi((s) => s.focus);
  useEffect(() => {
    if (!focus || focus.kind !== 'network') return;
    ui.consumeFocus(focus.seq);
    const e = networkStore.get(focus.netId);
    if (!e) {
      toast.info(t('network.toast.notInMemory'));
      return;
    }
    setPaused(false);
    if (!compiled.network(e)) {
      toast.info(t('network.toast.outOfScope'), { action: { label: t('network.toast.showAll'), onClick: () => setScope(ALL_SCOPE) } });
    } else if (!predicate(e)) {
      setQuery('');
      resetFilters();
      toast.info(t('network.toast.filtersCleared'));
    }
    select(e.id, { reveal: true, center: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);

  // A selection that left the store stays readable (marked as gone) until closed.
  useEffect(() => {
    if (!selectedId) setFallbackEntry(null);
  }, [selectedId]);

  /* ── palette ── */
  const group = t('common.groups.network');
  const sel = selected && !gone ? selected : null;
  useCommands([
    { id: 'network.clear', title: t('network.commands.clear'), group, icon: Eraser, shortcut: 'Mod+Backspace', keywords: ['clear', 'temizle', 'network', 'ağ'], run: () => void clear() },
    { id: 'network.pause', title: paused ? t('network.toolbar.resume') : t('network.toolbar.pause'), group, icon: paused ? Play : Pause, shortcut: 'Space', keywords: ['pause', 'duraklat', 'resume', 'devam'], run: togglePause },
    { id: 'network.follow', title: t('network.commands.follow'), group, icon: Radio, shortcut: 'G', keywords: ['follow', 'takip', 'newest', 'en yeni'], run: jumpToNewest },
    { id: 'network.har', title: t('network.commands.exportHar'), group, icon: FileDown, keywords: ['har', 'export', 'dışa aktar'], run: exportHar, disabled: rowIds.length === 0 },
    { id: 'network.resetFilters', title: t('network.filters.reset'), group, icon: FilterX, keywords: ['filter', 'filtre', 'reset', 'sıfırla'], run: () => { resetFilters(); setQuery(''); } },
    { id: 'network.errorsOnly', title: t('network.commands.errorsOnly'), group, icon: FilterX, keywords: ['errors', 'hatalar', 'failed'], run: () => patchFilters({ errorsOnly: !filters.errorsOnly }) },
    { id: 'network.bodySearch', title: bodySearch ? t('network.commands.bodySearchOff') : t('network.commands.bodySearchOn'), group, keywords: ['body', 'gövde', 'search', 'ara'], run: () => setBodySearch(!bodySearch) },
    ...(sel
      ? [
          { id: 'network.sel.share', title: t('network.share.title'), group, icon: Share2, keywords: ['share', 'paylaş', 'report', 'rapor', 'bug', 'hata', 'markdown'], run: () => setShareEntry(sel) },
          { id: 'network.sel.curl', title: t('network.menu.copyAs.curl'), group, icon: Copy, keywords: ['curl', 'copy', 'kopyala'], run: () => void copyEntryAs(sel, 'curl') },
          { id: 'network.sel.replay', title: t('network.menu.replay'), group, icon: RotateCw, keywords: ['replay', 'tekrar', 'gönder'], run: () => void doReplay(sel) },
          { id: 'network.sel.edit', title: t('network.menu.editReplayEllipsis'), group, icon: PencilLine, keywords: ['edit', 'düzenle', 'replay'], run: () => setReplayEntry(sel) },
          { id: 'network.sel.mock', title: t('network.menu.createMock'), group, icon: Drama, keywords: ['mock', 'oluştur'], run: () => void createMockFrom(sel) },
          { id: 'network.sel.logs', title: t('network.menu.showInLogs'), group, icon: ScrollText, keywords: ['logs', 'loglar'], run: () => showInLogs(sel) },
          { id: 'network.sel.compare', title: t('network.menu.compareEllipsis'), group, icon: ArrowLeftRight, keywords: ['compare', 'karşılaştır', 'diff'], run: () => setCompareBase(sel.id) },
        ]
      : []),
  ]);

  /* ── render ── */
  const hasFilters = query.trim() !== '' || filters.methods.length + filters.statuses.length + filters.types.length > 0 || !!filters.host || filters.errorsOnly || filters.slowOnly || filters.mockedOnly;

  const empty = useMemo(() => paused ? (
    <EmptyState
      size="md"
      icon={Pause}
      title={t('network.empty.pausedTitle')}
      description={waiting > 0 ? t('network.banner.pausedWaiting', { count: waiting }) : t('network.banner.paused')}
      actions={
        <Button icon={Play} onClick={togglePause}>
          {t('network.toolbar.resume')}
        </Button>
      }
    />
  ) : scopeTotal === 0 && compiled.scope.kind === 'device' && compiled.scope.deviceId === 'desktop' ? (
    <EmptyState size="lg" icon={RotateCw} title={t('network.empty.desktopTitle')} description={t('network.empty.desktopDescription')} />
  ) : scopeTotal === 0 ? (
      <ExplainEmpty
        capability="network"
        icon={ArrowLeftRight}
        fallback={
      <EmptyState
        size="lg"
        icon={ArrowLeftRight}
        title={t('network.empty.title')}
        description={noNetworkCapability ? t('network.empty.noCapability') : t('network.empty.description')}
        actions={
          <>
            <Button variant="primary" icon={BookOpen} onClick={() => ui.openSdkGuide('flutter')}>
              {t('network.empty.sdkGuide')}
            </Button>
            <Button variant="ghost" onClick={() => ui.openSdkGuide('flutter')}>
              {t('network.empty.vmService')}
            </Button>
          </>
        }
      >
        <ul className="net-empty__tips">
          <li>{t('network.empty.tipFlutter')}</li>
          <li>{t('network.empty.tipNative')}</li>
          <li>{t('network.empty.tipMocks')}</li>
        </ul>
      </EmptyState>
        }
      />
    ) : (
      <EmptyState
        size="md"
        icon={FilterX}
        title={t('network.empty.noMatchTitle')}
        description={t('network.empty.noMatchDescription', { total: formatNumber(scopeTotal) })}
        actions={
          hasFilters ? (
            <Button
              icon={X}
              onClick={() => {
                resetFilters();
                setQuery('');
              }}
            >
              {t('network.filters.reset')}
            </Button>
          ) : null
        }
      />
    ), [paused, waiting, scopeTotal, scopeKey, noNetworkCapability, hasFilters, t, resetFilters]); // eslint-disable-line react-hooks/exhaustive-deps

  const onHeaderContextMenu = useEvent((ev: MouseEvent) => openContextMenu(ev, columnItems()));

  const baseEntry = compareBase ? networkStore.get(compareBase) : undefined;

  return (
    <div className="net fill">
      <MainToolbar
        query={query}
        onQuery={setQuery}
        invalid={parsed.invalid}
        searchEnabled={active && !dialogOpen}
        bodySearch={bodySearch}
        onBodySearch={setBodySearch}
        bodyState={{ loading: body.loading, error: body.error, count: body.matches ? body.matches.size : null }}
        follow={follow && !!followEdge && !paused}
        followSorted={!followEdge}
        onFollow={() => (follow && followEdge && !paused ? setFollow(false) : jumpToNewest())}
        paused={paused}
        onPause={togglePause}
        onClear={() => void clear()}
        clearDisabled={scopeTotal === 0}
        onExportHar={exportHar}
        harDisabled={rowIds.length === 0}
        columnItems={columnItems}
        shown={rowIds.length}
        total={scopeTotal}
      />
      <FilterBar filters={filters} onChange={patchFilters} onReset={resetFilters} hostItems={hostItems} hasQuery={query.trim() !== ''} onClearQuery={() => setQuery('')} />
      {paused ? (
        <div className="net-banner net-banner--paused" role="status">
          <Pause size={13} aria-hidden />
          <span>{waiting > 0 ? t('network.banner.pausedWaiting', { count: waiting }) : t('network.banner.paused')}</span>
          <Button size="sm" variant="ghost" icon={Play} onClick={togglePause}>
            {t('network.toolbar.resume')}
          </Button>
        </div>
      ) : null}
      {baseEntry ? (
        <div className="net-banner net-banner--compare" role="status">
          <ArrowLeftRight size={13} aria-hidden />
          <span className="truncate">{t('network.banner.comparePick', { name: `${baseEntry.method} ${baseEntry.path}` })}</span>
          <Button size="sm" variant="ghost" onClick={() => setCompareBase(null)}>
            {t('network.banner.cancel')}
          </Button>
        </div>
      ) : null}
      <SplitPane
        id="network.detail"
        sizedPane="second"
        defaultSize={540}
        minSize={360}
        maxSize={0.75}
        collapsed={selected ? null : 'second'}
        onOverlayDismiss={() => setSelectedId(null)}
        className="net-split"
      >
        <NetworkTable
          rowIds={rowIds}
          version={v}
          columns={columns}
          prefs={colPrefs}
          onResizeColumn={onResizeColumn}
          onHeaderContextMenu={onHeaderContextMenu}
          sort={sort}
          onSort={onSort}
          selectedId={selectedId}
          marks={marks}
          compareBaseId={compareBase}
          onRowClick={onRowClick}
          onRowContextMenu={onRowContextMenu}
          slowMs={filters.slowMs}
          followEdge={followEdge}
          follow={follow && !paused}
          onFollowChange={setFollow}
          newCount={newCount}
          reveal={reveal}
          rowHeight={rowHeight}
          lang={lang}
          active={active}
          empty={empty}
          aria-label={t('network.table.label')}
        />
        {selected ? (
          <DetailPanel
            key={selected.id}
            entry={selected}
            gone={gone}
            onClose={() => setSelectedId(null)}
            onReplay={() => void doReplay(selected)}
            onEditReplay={() => setReplayEntry(selected)}
            onCompare={() => setCompareBase(selected.id)}
            onShare={() => setShareEntry(selected)}
          />
        ) : (
          <span />
        )}
      </SplitPane>
      {replayEntry ? <ReplayDialog entry={replayEntry} onClose={() => setReplayEntry(null)} onSent={(res) => {
        setFallbackEntry(res);
        select(res.id, { reveal: true });
      }} /> : null}
      {shareEntry ? <ShareDialog entry={shareEntry} gone={!networkStore.get(shareEntry.id)} onClose={() => setShareEntry(null)} /> : null}
      {comparePair ? (
        <CompareDialog
          a={comparePair[0]}
          b={comparePair[1]}
          onClose={() => {
            setComparePair(null);
            setMarks([]);
          }}
        />
      ) : null}
      <span className="sr-only" aria-live="polite">
        {selected ? `${selected.method} ${selected.path} ${selected.status ?? ''} ${selected.duration !== undefined ? formatDuration(selected.duration) : ''}` : ''}
      </span>
    </div>
  );
}

