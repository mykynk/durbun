import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import {
  ArrowDownToLine,
  Bell,
  Bookmark,
  Braces,
  Copy,
  ExternalLink,
  FileDown,
  Funnel,
  FunnelX,
  Highlighter as HighlighterIcon,
  ListFilter,
  LocateFixed,
  OctagonX,
  Pause,
  Search,
  Trash2,
  VolumeX,
  WrapText,
} from 'lucide-react';
import { LOG_LEVELS, type AppSession, type LogEntry, type LogLevel, type LogSource } from '@durbun/protocol';
import {
  ALL_SCOPE,
  compileNoiseRules,
  isCrashEntry,
  logStore,
  networkStore,
  sendCommand,
  setScope,
  ui,
  useCompiledScope,
  useDevice,
  useHub,
  useLogVersion,
  usePrefs,
  scopeLogCounts,
  useUi,
  type Scope,
} from '../../data';
import {
  SplitPane,
  confirm,
  copyText,
  downloadText,
  formatCompact,
  notificationPermission,
  notifyDesktop,
  openContextMenu,
  requestNotificationPermission,
  toast,
  useCommands,
  useFeatureActive,
  usePersistentState,
  useShortcut,
  type MenuItem,
} from '../../components';
import { deviceDisplayName, errorText, t, useLanguage, useT } from '../../i18n';
import { compileLogQuery, parseLogQuery, queryMinLevel, type QuerySuggestData } from './query';
import './i18n';
import './logs.css';
import { RowModel } from './model/rowModel';
import { rankOf, type LogRow, type RowFilter, type SourceToggles } from './model/types';
import { buildHighlighter } from './model/highlight';
import { appIdentity, type AppIdentity } from './model/frames';
import { analyzeEntry } from './model/analyze';
import { exportFileName, exportJson, exportTxt } from './model/export';
import { makeTerm, pushHistory, sanitizeSavedFilters, toggleTerm, type QueryField, type SavedFilter } from './model/queryEdit';
import { useLiveCrashes } from './live';
import { LogList, type LogListHandle } from './components/LogList';
import { EXPAND_JSON, EXPAND_LINES, EXPAND_STACK, type RowDisplay } from './components/LogRow';
import { FilterChips, LogsToolbar, SourceFilters } from './components/Toolbar';
import { DetailPanel, displayText, entryAsLine } from './components/DetailPanel';
import { Histogram } from './components/Histogram';
import { CrashBanner, NewLinesPill, PausedBar, crashTitle } from './components/Banners';
import { NoLogsState, NoMatchState, type ActiveFilter } from './components/EmptyStates';
import { HighlightRulesDialog, NoiseRulesDialog, SavedFiltersDialog } from './components/RulesDialogs';

const ALL_SOURCES: SourceToggles = { device: true, app: true, system: true };
const SOURCES: readonly LogSource[] = ['device', 'app', 'system'];
const MENU_LEVELS: readonly LogLevel[] = ['verbose', 'debug', 'info', 'warn', 'error'];
/** Level names in prose (technical names, SPEC §7.1) — the pills keep their letters / caps. */
const LEVEL_NAME: Record<LogLevel, string> = { verbose: 'Verbose', debug: 'Debug', info: 'Info', warn: 'Warn', error: 'Error', fatal: 'Fatal' };

function sanitizeSources(v: unknown): SourceToggles {
  if (!v || typeof v !== 'object') return ALL_SOURCES;
  const o = v as Partial<Record<LogSource, unknown>>;
  return { device: o.device !== false, app: o.app !== false, system: o.system !== false };
}

/** What in the app sessions matters for scope/query compilation (stats churn is ignored). */
function appsSignature(apps: Record<string, AppSession>): string {
  return Object.values(apps)
    .map((a) => `${a.id}|${a.deviceId}|${a.app.id}|${a.app.name}|${a.app.processName ?? ''}|${a.app.pid ?? ''}|${a.sdk.platform}`)
    .sort()
    .join('\n');
}

function scopeSignature(scope: Scope, appsSig: string): string {
  if (scope.kind === 'all') return 'all';
  if (scope.kind === 'device') return `d:${scope.deviceId}`;
  return `a:${scope.appId}:${scope.exact ? 1 : 0}:${appsSig}`;
}

/** Noise predicate with a per-entry cache (scope switches rescan 200k entries). */
function cachedNoise(fn: (e: LogEntry) => boolean): (e: LogEntry) => boolean {
  const cache = new WeakMap<LogEntry, boolean>();
  return (e) => {
    if (e.source !== 'device') return false;
    let v = cache.get(e);
    if (v === undefined) {
      v = fn(e);
      cache.set(e, v);
    }
    return v;
  };
}

/** Tiny external store for the visible time window (histogram highlight) — no view re-render on scroll. */
function createWindowStore() {
  let value: { from: number; to: number } | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(v: { from: number; to: number } | null) {
      if (v === value || (v && value && v.from === value.from && v.to === value.to)) return;
      value = v;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

type WindowStore = ReturnType<typeof createWindowStore>;

function HistogramSlot({ model, version, win, onJump }: { model: RowModel; version: number; win: WindowStore; onJump(ts: number): void }) {
  const visible = useSyncExternalStore(win.subscribe, win.get, win.get);
  return <Histogram hist={model.hist} version={version} visible={visible} onJump={onJump} />;
}

export default function LogsView() {
  useT();
  const lang = useLanguage();
  const active = useFeatureActive();

  /* ───── prefs ───── */
  const timeFormat = usePrefs((s) => s.timeFormat);
  const wrapLines = usePrefs((s) => s.wrapLines);
  const showNetwork = usePrefs((s) => s.showNetworkInLogs);
  const hideNoise = usePrefs((s) => s.hideNoise);
  const noiseRules = usePrefs((s) => s.noiseRules);
  const highlightRules = usePrefs((s) => s.highlightRules);
  const fontSize = usePrefs((s) => s.logFontSize);
  const density = usePrefs((s) => s.density);
  const setPref = usePrefs((s) => s.setPref);

  /* ───── persisted view state ───── */
  const [queryRaw, setQueryState] = usePersistentState<string>('logs.query', '');
  const query = typeof queryRaw === 'string' ? queryRaw : '';
  const [appliedQuery, setAppliedQuery] = useState(query);
  const [minLevelRaw, setMinLevel] = usePersistentState<LogLevel>('logs.minLevel', 'verbose');
  const minLevel: LogLevel = LOG_LEVELS.includes(minLevelRaw) ? minLevelRaw : 'verbose';
  const [sourcesRaw, setSources] = usePersistentState<SourceToggles>('logs.sources', ALL_SOURCES);
  const sources = useMemo(() => sanitizeSources(sourcesRaw), [sourcesRaw]);
  const [dedupe, setDedupe] = usePersistentState<boolean>('logs.dedupe', true);
  const [fold, setFold] = usePersistentState<boolean>('logs.fold', true);
  const [historyRaw, setHistory] = usePersistentState<string[]>('logs.queryHistory', []);
  const [savedRaw, setSaved] = usePersistentState<SavedFilter[]>('logs.savedFilters', []);
  const saved = useMemo(() => sanitizeSavedFilters(savedRaw), [savedRaw]);

  /* ───── transient state ───── */
  const [paused, setPaused] = useState(false);
  const [following, setFollowingState] = useState(true);
  const followingRef = useRef(true);
  const [sel, setSel] = useState<{ id: number; entry: LogEntry } | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlyMap<number, number>>(() => new Map());
  const [flashId, setFlashId] = useState<number | null>(null);
  const [dialog, setDialog] = useState<'noise' | 'highlight' | 'saved' | null>(null);
  const [ageTick, setAgeTick] = useState(0);
  const listRef = useRef<LogListHandle>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [win] = useState(createWindowStore);
  const [model] = useState(() => new RowModel());

  // Debounce typing: parse on every keystroke (highlighting), filter 150 ms after the last one.
  useEffect(() => {
    if (query === appliedQuery) return;
    const id = setTimeout(() => setAppliedQuery(query), 150);
    return () => clearTimeout(id);
  }, [query, appliedQuery]);
  const setQueryNow = useCallback(
    (q: string) => {
      setQueryState(q);
      setAppliedQuery(q);
    },
    [setQueryState],
  );

  /* ───── scope & apps (stats churn ignored via signatures) ───── */
  const compiledScope = useCompiledScope();
  const apps = useHub((s) => s.apps);
  const appsRef = useRef(apps);
  appsRef.current = apps;
  const appsSig = useMemo(() => appsSignature(apps), [apps]);
  const scopeKey = scopeSignature(compiledScope.scope, appsSig);
  const scopeRef = useRef(compiledScope);
  scopeRef.current = compiledScope;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scopeFn = useMemo(() => compiledScope.logs, [scopeKey]);
  const scopeDevice = useDevice(compiledScope.deviceId);

  /* ───── query ───── */
  const parsed = useMemo(() => parseLogQuery(query), [query]);
  const appliedParsed = useMemo(() => (appliedQuery === query ? parsed : parseLogQuery(appliedQuery)), [appliedQuery, query, parsed]);
  const compiledQuery = useMemo(
    () => compileLogQuery(appliedParsed, { now: Date.now(), apps: appsRef.current }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appliedParsed, appsSig, ageTick],
  );
  const queryMin = useMemo(() => queryMinLevel(appliedParsed), [appliedParsed]);
  useEffect(() => {
    if (!compiledQuery.hasAge || !active) return;
    const id = setInterval(() => setAgeTick((x) => x + 1), 5000);
    return () => clearInterval(id);
  }, [compiledQuery.hasAge, active]);

  const noiseFn = useMemo(() => cachedNoise(compileNoiseRules(noiseRules)), [noiseRules]);

  const filter = useMemo<RowFilter>(
    () => ({
      scope: scopeFn,
      minRank: rankOf(minLevel),
      queryMinRank: queryMin ? rankOf(queryMin) : 0,
      sources,
      hideNoise,
      noise: noiseFn,
      showNetwork,
      query: compiledQuery,
      dedupe,
      fold,
    }),
    [scopeFn, minLevel, queryMin, sources, hideNoise, noiseFn, showNetwork, compiledQuery, dedupe, fold],
  );

  /* ───── rows (incremental; frozen while paused) ───── */
  const v = useLogVersion({ enabled: active });
  const snap = useMemo(() => {
    const rebuilt = model.setFilter(filter);
    let pending = 0;
    if (paused && !rebuilt && model.build > 0) pending = model.countPending(logStore);
    else model.sync(logStore);
    return {
      version: model.version,
      structure: model.structure,
      count: model.count,
      appended: model.appended,
      build: model.build,
      counts: { ...model.counts },
      pending,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, filter, paused, model]);

  /* ───── following / "↓ N new" ───── */
  const unfollowMark = useRef({ build: 0, appended: 0 });
  const setFollowing = useCallback(
    (f: boolean) => {
      if (!f && followingRef.current) unfollowMark.current = { build: model.build, appended: model.appended };
      followingRef.current = f;
      setFollowingState(f);
    },
    [model],
  );
  const newCount = following || unfollowMark.current.build !== snap.build ? 0 : Math.max(0, snap.appended - unfollowMark.current.appended);

  const jumpToEnd = useCallback(() => {
    setPaused(false);
    setFollowing(true);
    listRef.current?.scrollToEnd();
    requestAnimationFrame(() => listRef.current?.scrollToEnd());
  }, [setFollowing]);

  const togglePause = useCallback(() => {
    setPaused((p) => {
      if (p) requestAnimationFrame(() => followingRef.current && listRef.current?.scrollToEnd());
      return !p;
    });
  }, []);

  /* ───── display options ───── */
  const hl = useMemo(() => buildHighlighter(compiledQuery.highlights, highlightRules), [compiledQuery, highlightRules]);
  const impliedProcesses = useMemo(() => {
    const s = new Set<string>();
    if (compiledScope.scope.kind === 'app' && compiledScope.app) {
      const key = `${compiledScope.app.deviceId}|${compiledScope.app.app.id}`;
      for (const a of Object.values(appsRef.current)) {
        if (`${a.deviceId}|${a.app.id}` !== key) continue;
        s.add(a.app.id);
        if (a.app.processName) s.add(a.app.processName);
      }
    }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  const appForEntry = useCallback((e: LogEntry): AppSession | undefined => {
    const all = appsRef.current;
    if (e.appId && all[e.appId]) return all[e.appId];
    // Device lines: the process is the app; ANRs / tombstones name the package in the message or data.
    const data = e.data as { package?: unknown } | undefined;
    const proc =
      (e.kind === 'anr' ? /ANR in (\S+)/.exec(e.message)?.[1] : undefined) ??
      (typeof data?.package === 'string' ? data.package : undefined) ??
      e.process;
    if (proc) {
      let best: AppSession | undefined;
      for (const a of Object.values(all)) {
        if (a.deviceId !== e.deviceId) continue;
        if (a.app.id === proc || a.app.processName === proc || proc.startsWith(`${a.app.id}:`)) {
          if (!best || a.connectedAt > best.connectedAt) best = a;
        }
      }
      if (best) return best;
    }
    return undefined;
  }, []);

  const identity = useMemo(() => {
    const cache = new Map<string, AppIdentity>();
    return (e: LogEntry): AppIdentity => {
      const key = e.appId ?? `${e.deviceId}|${e.process ?? ''}`;
      let id = cache.get(key);
      if (!id) {
        const app = appForEntry(e) ?? scopeRef.current.app;
        id = appIdentity(app ? [{ id: app.app.id, name: app.app.name, processName: app.app.processName }] : []);
        cache.set(key, id);
      }
      return id;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appsSig, scopeKey]);

  const appName = useCallback((e: LogEntry) => appForEntry(e)?.app.name, [appForEntry]);

  const d = useMemo<RowDisplay>(
    () => ({ timeFormat, wrap: wrapLines, lang, hl, impliedProcesses, identity, appName }),
    [timeFormat, wrapLines, lang, hl, impliedProcesses, identity, appName],
  );
  const rowHeight = Math.max(density === 'comfortable' ? 24 : 20, Math.round(fontSize * 1.45));
  const measureKey = `${fontSize}|${density}|${wrapLines}`;

  /* ───── selection ───── */
  const selIndex = sel ? model.indexOfRow(sel.id) : -1;
  const selRow = selIndex >= 0 ? model.row(selIndex) : undefined;

  const selectRow = useCallback((row: LogRow, open: boolean) => {
    setSel({ id: row.id, entry: row.e });
    if (open) setDetailOpen(true);
  }, []);

  const move = useCallback(
    (delta: number) => {
      if (model.count === 0) return;
      let idx = sel ? model.indexOfRow(sel.id) : -1;
      if (idx < 0) {
        const r = listRef.current?.visibleRange();
        idx = delta > 0 ? (r ? r.first - 1 : -1) : r ? r.last + 1 : model.count;
      }
      const next = Math.max(0, Math.min(model.count - 1, idx + delta));
      const row = model.row(next);
      if (!row) return;
      setSel({ id: row.id, entry: row.e });
      setFollowing(false);
      listRef.current?.scrollToIndex(next, 'auto');
    },
    [model, sel, setFollowing],
  );

  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((rowId: number) => {
    setFlashId(rowId);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), 1700);
  }, []);
  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  /* ───── filters ───── */
  const toggleSource = useCallback((s: LogSource) => setSources((cur) => ({ ...sanitizeSources(cur), [s]: !sanitizeSources(cur)[s] })), [setSources]);
  const clearFilters = useCallback(() => {
    setQueryNow('');
    setMinLevel('verbose');
    setSources(ALL_SOURCES);
  }, [setQueryNow, setMinLevel, setSources]);

  const applyTerm = useCallback((term: string) => setQueryNow(toggleTerm(query, term)), [query, setQueryNow]);
  const filterBy = useCallback((field: QueryField, value: string | number, exclude: boolean) => applyTerm(makeTerm(field, value, { exclude })), [applyTerm]);

  const submitQuery = useCallback(
    (q: string) => {
      setAppliedQuery(q);
      if (q.trim()) setHistory((h) => pushHistory(Array.isArray(h) ? h : [], q));
    },
    [setHistory],
  );

  const getSuggestData = useCallback((): QuerySuggestData => {
    const tags = new Map<string, number>();
    const procs = new Map<string, number>();
    const entries = logStore.entries;
    const scope = scopeRef.current.logs;
    for (let i = entries.length - 1, n = 0; i >= 0 && n < 6000; i--, n++) {
      const e = entries[i]!;
      if (!scope(e)) continue;
      if (e.tag) tags.set(e.tag, (tags.get(e.tag) ?? 0) + 1);
      if (e.process) procs.set(e.process, (procs.get(e.process) ?? 0) + 1);
    }
    const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([k]) => k);
    return {
      tags: top(tags),
      processes: top(procs),
      apps: Object.values(appsRef.current).map((a) => ({ id: a.id, name: a.app.name, bundleId: a.app.id })),
      history: Array.isArray(historyRaw) ? historyRaw.filter((h) => typeof h === 'string') : [],
    };
  }, [historyRaw]);

  /* ───── reveal ("show in context", ui.focus, crash banner) ───── */
  const pendingReveal = useRef<{ id: number; build: number; tries: number; open: boolean } | null>(null);
  const [revealTick, setRevealTick] = useState(0);
  const revealEntry = useCallback(
    (entryId: number, opts: { open?: boolean; anyScope?: boolean } = {}) => {
      const e = logStore.getById(entryId) ?? (sel?.entry.id === entryId ? sel.entry : undefined);
      if (!e) {
        toast.info(t('logs.reveal.gone'));
        return;
      }
      if (opts.anyScope && !scopeRef.current.logs(e)) setScope(ALL_SCOPE);
      setQueryNow('');
      setMinLevel('verbose');
      setSources(ALL_SOURCES);
      const prefs = usePrefs.getState();
      if (prefs.hideNoise && noiseFn(e)) prefs.setPref('hideNoise', false);
      if (e.kind === 'network' && !prefs.showNetworkInLogs) prefs.setPref('showNetworkInLogs', true);
      setPaused(false);
      setFollowing(false);
      setSel({ id: entryId, entry: e });
      if (opts.open) setDetailOpen(true);
      pendingReveal.current = { id: entryId, build: model.build, tries: 0, open: !!opts.open };
      setRevealTick((x) => x + 1);
    },
    [model, sel, noiseFn, setQueryNow, setMinLevel, setSources, setFollowing],
  );

  useEffect(() => {
    const p = pendingReveal.current;
    if (!p) return;
    let idx = model.indexOfEntry(p.id);
    if (idx < 0) {
      if (model.build === p.build && p.tries++ < 2) return;
      idx = model.nearestIndex(p.id);
    }
    pendingReveal.current = null;
    if (idx < 0) return;
    const row = model.row(idx)!;
    const entry = row.e.id === p.id ? row.e : (logStore.getById(p.id) ?? row.e);
    setSel({ id: row.id, entry });
    listRef.current?.scrollToIndex(idx, 'center');
    requestAnimationFrame(() => listRef.current?.scrollToIndex(idx, 'center'));
    flash(row.id);
  }, [snap, revealTick, model, flash]);

  // After a rebuild (filter / scope / clear): keep the selected row in view, otherwise go live.
  const lastBuild = useRef(-1);
  useEffect(() => {
    if (lastBuild.current === snap.build) return;
    lastBuild.current = snap.build;
    // Rows that existed when the list was rebuilt are not "new".
    unfollowMark.current = { build: snap.build, appended: model.appended };
    if (pendingReveal.current || paused) return;
    const idx = sel ? model.indexOfRow(sel.id) : -1;
    if (idx >= 0 && !followingRef.current) {
      listRef.current?.scrollToIndex(idx, 'center');
      return;
    }
    setFollowing(true);
    listRef.current?.scrollToEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.build]);

  const focus = useUi((s) => s.focus);
  useEffect(() => {
    if (!focus || focus.kind !== 'log') return;
    revealEntry(focus.logId, { anyScope: true, open: true });
    ui.consumeFocus(focus.seq);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);

  /* ───── expand / row actions ───── */
  const toggleExpand = useCallback((rowId: number, bit: number) => {
    setExpanded((m) => {
      const next = new Map(m);
      const cur = next.get(rowId) ?? 0;
      const v2 = cur & bit ? cur & ~bit : cur | bit;
      if (v2) next.set(rowId, v2);
      else next.delete(rowId);
      return next;
    });
  }, []);

  const copy = useCallback(async (text: string) => {
    const ok = await copyText(text);
    if (ok) toast.success(t('common.copied'));
    else toast.error(t('common.copyFailed'));
  }, []);

  const onRowClick = useCallback(
    (row: LogRow) => {
      selectRow(row, true);
    },
    [selectRow],
  );

  const onRowAction = useCallback(
    (act: string, row: LogRow, value: string | undefined, ev: MouseEvent) => {
      switch (act) {
        case 'tag':
          applyTerm(makeTerm('tag', value ?? row.e.tag, { exclude: ev.altKey }));
          break;
        case 'proc':
          applyTerm(makeTerm('process', value ?? row.e.process ?? '', { exclude: ev.altKey }));
          break;
        case 'app':
          if (value) applyTerm(makeTerm('app', value, { exclude: ev.altKey }));
          break;
        case 'lines':
          listRef.current?.pinRow(row.id);
          toggleExpand(row.id, EXPAND_LINES);
          break;
        case 'stack':
          listRef.current?.pinRow(row.id);
          toggleExpand(row.id, EXPAND_STACK);
          break;
        case 'json':
          listRef.current?.pinRow(row.id);
          toggleExpand(row.id, EXPAND_JSON);
          break;
        case 'net':
          if (row.e.netId && networkStore.get(row.e.netId)) ui.focusNetwork(row.e.netId);
          else selectRow(row, true);
          break;
        default:
          break;
      }
    },
    [applyTerm, toggleExpand, selectRow],
  );

  const onRowContextMenu = useCallback(
    (row: LogRow, _index: number, ev: MouseEvent) => {
      const e = row.e;
      selectRow(row, false);
      const items: MenuItem[] = [
        { label: t('logs.ctx.copyMessage'), icon: Copy, onSelect: () => void copy(displayText(e)) },
        { label: t('logs.ctx.copyLine'), onSelect: () => void copy(entryAsLine(e, row.n)) },
        { label: t('logs.ctx.copyJson'), icon: Braces, onSelect: () => void copy(JSON.stringify(e, null, 2)) },
        { type: 'separator' },
      ];
      if (e.tag) {
        items.push({ label: t('logs.ctx.filterTag', { tag: e.tag }), icon: Funnel, onSelect: () => filterBy('tag', e.tag, false) });
        items.push({ label: t('logs.ctx.excludeTag', { tag: e.tag }), icon: FunnelX, onSelect: () => filterBy('tag', e.tag, true) });
      }
      if (e.process) {
        items.push({ label: t('logs.ctx.filterProcess', { process: e.process }), icon: Funnel, onSelect: () => filterBy('process', e.process!, false) });
        items.push({ label: t('logs.ctx.excludeProcess', { process: e.process }), icon: FunnelX, onSelect: () => filterBy('process', e.process!, true) });
      }
      items.push({ type: 'separator' });
      items.push({ label: t('logs.ctx.openDetail'), shortcut: 'Enter', onSelect: () => selectRow(row, true) });
      items.push({ label: t('logs.ctx.showInContext'), icon: LocateFixed, onSelect: () => revealEntry(e.id, { open: true }) });
      if (e.kind === 'network' && e.netId && networkStore.get(e.netId)) items.push({ label: t('logs.ctx.openNetwork'), icon: ExternalLink, onSelect: () => ui.focusNetwork(e.netId!) });
      openContextMenu(ev, items);
    },
    [copy, filterBy, revealEntry, selectRow],
  );

  const onRangeChange = useCallback(
    (first: number, last: number) => {
      const a = model.row(first);
      const b = model.row(Math.min(last, model.count - 1));
      if (!a || !b) {
        win.set(null);
        return;
      }
      win.set({ from: Math.min(a.e.ts, b.e.ts), to: Math.max(a.e.ts, b.e.ts) });
    },
    [model, win],
  );

  const onHistogramJump = useCallback(
    (ts: number) => {
      const idx = model.indexAtTime(ts);
      if (idx < 0) return;
      setFollowing(false);
      listRef.current?.scrollToIndex(idx, 'start');
    },
    [model, setFollowing],
  );

  /* ───── commands: marker, clear, export ───── */
  const addMarker = useCallback(async (label?: string) => {
    try {
      await sendCommand({ name: 'marker.add', label, deviceId: scopeRef.current.deviceId });
    } catch (err) {
      toast.error(t('logs.marker.failed'), { description: errorText(err) });
    }
  }, []);

  const clearLogs = useCallback(
    async (skipConfirm: boolean) => {
      const cs = scopeRef.current;
      const scope = cs.scope;
      if (!skipConfirm) {
        const message =
          scope.kind === 'all'
            ? t('logs.clear.all')
            : scope.kind === 'device'
              ? t('logs.clear.device', { name: deviceDisplayName(useHub.getState().devices[scope.deviceId], scope.deviceId) })
              : t('logs.clear.app', { name: cs.app?.app.name ?? scope.appId });
        const ok = await confirm({ title: t('logs.clear.title'), message, confirmLabel: t('logs.clear.confirm'), danger: true, icon: Trash2 });
        if (!ok) return;
      }
      try {
        if (scope.kind === 'all') await sendCommand({ name: 'clear', target: 'logs' });
        else if (scope.kind === 'device') await sendCommand({ name: 'clear', target: 'logs', deviceId: scope.deviceId });
        else {
          const ids = cs.appIds && cs.appIds.size ? [...cs.appIds] : [scope.appId];
          await Promise.all(ids.map((appId) => sendCommand({ name: 'clear', target: 'logs', deviceId: cs.deviceId, appId })));
        }
        setPaused(false);
        setSel(null);
        setDetailOpen(false);
        setExpanded(new Map());
        setFollowing(true);
      } catch (err) {
        toast.error(t('logs.clear.failed'), { description: errorText(err) });
      }
    },
    [setFollowing],
  );

  const scopeLabel = useCallback((): string => {
    const cs = scopeRef.current;
    if (cs.scope.kind === 'all') return t('shell.scope.all');
    if (cs.scope.kind === 'device') return deviceDisplayName(useHub.getState().devices[cs.scope.deviceId], cs.scope.deviceId);
    return cs.app ? `${cs.app.app.name} · ${deviceDisplayName(useHub.getState().devices[cs.app.deviceId], cs.app.deviceId)}` : cs.scope.appId;
  }, []);

  const exportVisible = useCallback(
    (fmt: 'txt' | 'json') => {
      const rows = model.rows.slice(model.start);
      if (rows.length === 0) {
        toast.info(t('logs.export.empty'));
        return;
      }
      try {
        const scope = scopeLabel();
        if (fmt === 'txt') {
          const header = [t('logs.export.headerTitle'), t('logs.export.headerScope', { scope }), t('logs.export.headerRows', { count: rows.length })];
          if (appliedQuery.trim()) header.push(t('logs.export.headerQuery', { query: appliedQuery.trim() }));
          downloadText(exportTxt(rows, { text: displayText, header }), exportFileName('txt'));
        } else {
          downloadText(exportJson(rows, { exportedAt: new Date().toISOString(), scope, query: appliedQuery.trim() || undefined }), exportFileName('json'), 'application/json');
        }
        toast.success(t('logs.export.done', { count: rows.length }));
      } catch (err) {
        toast.error(errorText(err));
      }
    },
    [model, scopeLabel, appliedQuery],
  );

  /* ───── crashes ───── */
  const lastNotify = useRef(0);
  const onLiveCrash = useCallback(
    (e: LogEntry) => {
      if (!usePrefs.getState().notifyOnCrash) return;
      const now = Date.now();
      if (now - lastNotify.current < 5000) return;
      lastNotify.current = now;
      notifyDesktop(crashTitle(e, appName(e)), {
        body: analyzeEntry(e).crash?.title ?? e.message.slice(0, 200),
        tag: 'durbun-crash',
        onClick: () => ui.focusLog(e.id),
      });
    },
    [appName],
  );
  const [crashState, dismissCrash] = useLiveCrashes(scopeFn, scopeKey, onLiveCrash);
  const bannerCrashes = useMemo(() => crashState.list.filter((e) => e.id > crashState.dismissedId), [crashState]);
  const gotoCrash = useCallback(
    (e: LogEntry) => {
      dismissCrash(e.id);
      revealEntry(e.id, { open: true });
    },
    [dismissCrash, revealEntry],
  );
  const gotoLatestCrash = useCallback(() => {
    const entries = logStore.entries;
    const scope = scopeRef.current.logs;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (isCrashEntry(e) && scope(e)) {
        revealEntry(e.id, { open: true });
        return;
      }
    }
    toast.info(t('logs.crash.none'));
  }, [revealEntry]);

  const toggleNotify = useCallback(async () => {
    const prefs = usePrefs.getState();
    if (prefs.notifyOnCrash) {
      prefs.setPref('notifyOnCrash', false);
      return;
    }
    if (notificationPermission() === 'unsupported') {
      toast.warn(t('logs.notify.unsupported'));
      return;
    }
    const perm = await requestNotificationPermission();
    if (perm === 'granted') prefs.setPref('notifyOnCrash', true);
    else toast.warn(t('logs.notify.denied'));
  }, []);

  /* ───── menu ───── */
  const menuItems = useCallback(
    (): MenuItem[] => [
      { label: t('logs.export.txt'), icon: FileDown, onSelect: () => exportVisible('txt') },
      { label: t('logs.export.json'), icon: Braces, onSelect: () => exportVisible('json') },
      { type: 'separator' },
      { label: t('logs.rules.noiseEdit'), icon: VolumeX, onSelect: () => setDialog('noise') },
      { label: t('logs.rules.highlightEdit'), icon: HighlighterIcon, onSelect: () => setDialog('highlight') },
      { label: t('logs.saved.manage'), icon: ListFilter, onSelect: () => setDialog('saved') },
      { type: 'separator' },
      { label: t('logs.crash.latest'), icon: OctagonX, onSelect: gotoLatestCrash },
      { label: t('logs.notify.toggle'), icon: Bell, checked: usePrefs.getState().notifyOnCrash, onSelect: () => void toggleNotify() },
    ],
    [exportVisible, gotoLatestCrash, toggleNotify],
  );

  /* ───── shortcuts (only while the tab is visible) ───── */
  useShortcut(['ArrowDown', 'J'], () => move(1), { enabled: active, allowRepeat: true });
  useShortcut(['ArrowUp', 'K'], () => move(-1), { enabled: active, allowRepeat: true });
  useShortcut(
    'Enter',
    () => {
      if (!sel) return false;
      setDetailOpen(true);
    },
    { enabled: active },
  );
  useShortcut(
    'Escape',
    () => {
      if (detailOpen) {
        setDetailOpen(false);
        return;
      }
      if (sel) {
        setSel(null);
        return;
      }
      return false;
    },
    { enabled: active },
  );
  useShortcut('Space', togglePause, { enabled: active });
  useShortcut(['G', 'Shift+G'], jumpToEnd, { enabled: active });
  // Overrides the shell's fallback marker shortcut (priority -10) while the Logs tab is visible.
  useShortcut('M', () => void addMarker(), { enabled: active, priority: 10 });
  useShortcut(['Mod+Backspace', 'Mod+Shift+Backspace'], (e) => void clearLogs(e.shiftKey), { enabled: active, allowInInputs: false });

  /* ───── palette ───── */
  const group = t('common.groups.logs');
  useCommands([
    { id: 'logs.search', title: t('logs.cmd.search'), group, icon: Search, shortcut: '/', keywords: ['search', 'ara', 'filter', 'filtre', 'query', 'sorgu'], run: () => { ui.setTab('logs'); requestAnimationFrame(() => inputRef.current?.focus()); } },
    { id: 'logs.clear', title: t('logs.cmd.clear'), group, icon: Trash2, shortcut: 'Mod+Backspace', keywords: ['clear', 'temizle', 'logs', 'loglar'], run: () => void clearLogs(false) },
    { id: 'logs.marker', title: t('logs.cmd.marker'), group, icon: Bookmark, shortcut: 'M', keywords: ['marker', 'işaret', 'isaret'], run: () => void addMarker() },
    following
      ? { id: 'logs.follow', title: t('logs.cmd.unfollow'), group, icon: ArrowDownToLine, keywords: ['follow', 'takip', 'canlı', 'live'], run: () => setFollowing(false) }
      : { id: 'logs.follow', title: t('logs.cmd.follow'), group, icon: ArrowDownToLine, shortcut: 'G', keywords: ['follow', 'takip', 'canlı', 'live', 'bottom'], run: () => { ui.setTab('logs'); jumpToEnd(); } },
    { id: 'logs.pause', title: paused ? t('logs.cmd.resume') : t('logs.cmd.pause'), group, icon: Pause, shortcut: 'Space', keywords: ['pause', 'resume', 'duraklat', 'devam'], run: togglePause },
    { id: 'logs.noise', title: hideNoise ? t('logs.cmd.showNoise') : t('logs.cmd.hideNoise'), group, icon: VolumeX, keywords: ['noise', 'gürültü', 'gurultu'], run: () => setPref('hideNoise', !hideNoise) },
    ...MENU_LEVELS.map((l) => ({
      id: `logs.level.${l}`,
      title: t('logs.level.set', { level: LEVEL_NAME[l] }),
      subtitle: t(`logs.level.${l}`),
      group,
      icon: ListFilter,
      keywords: ['level', 'seviye', l],
      run: () => setMinLevel(l),
    })),
    { id: 'logs.export.txt', title: t('logs.cmd.exportTxt'), group, icon: FileDown, keywords: ['export', 'dışa aktar', 'txt'], run: () => exportVisible('txt') },
    { id: 'logs.export.json', title: t('logs.cmd.exportJson'), group, icon: FileDown, keywords: ['export', 'dışa aktar', 'json'], run: () => exportVisible('json') },
    { id: 'logs.crash.latest', title: t('logs.cmd.latestCrash'), group, icon: OctagonX, keywords: ['crash', 'çökme', 'anr', 'error'], run: () => { ui.setTab('logs'); gotoLatestCrash(); } },
    { id: 'logs.wrap', title: t('logs.cmd.wrap'), group, icon: WrapText, keywords: ['wrap', 'kaydır'], run: () => setPref('wrapLines', !wrapLines) },
    { id: 'logs.clearFilters', title: t('logs.cmd.clearFilters'), group, icon: FunnelX, keywords: ['filter', 'filtre', 'reset'], run: clearFilters },
    { id: 'logs.noiseRules', title: t('logs.cmd.noiseRules'), group, icon: VolumeX, keywords: ['noise', 'gürültü', 'rules', 'kural'], run: () => { ui.setTab('logs'); setDialog('noise'); } },
    { id: 'logs.highlightRules', title: t('logs.cmd.highlightRules'), group, icon: HighlighterIcon, keywords: ['highlight', 'vurgu', 'color', 'renk'], run: () => { ui.setTab('logs'); setDialog('highlight'); } },
  ]);

  /* ───── stable callbacks for the memoized toolbar / chips ───── */
  const hideNoiseRef = useRef(hideNoise);
  hideNoiseRef.current = hideNoise;
  const onToggleNoise = useCallback(() => usePrefs.getState().setPref('hideNoise', !hideNoiseRef.current), []);
  const liveRef = useRef(false);
  liveRef.current = following && !paused;
  const onFollowButton = useCallback(() => {
    if (liveRef.current) setFollowing(false);
    else jumpToEnd();
  }, [setFollowing, jumpToEnd]);
  const onAddMarkerLabel = useCallback((label?: string) => void addMarker(label), [addMarker]);
  const onClearButton = useCallback((skip: boolean) => void clearLogs(skip), [clearLogs]);
  const queryRef = useRef(query);
  queryRef.current = query;
  const onApplyChip = useCallback(
    (q: string) => {
      setQueryNow(q);
      if (q) setHistory((h) => pushHistory(Array.isArray(h) ? h : [], q));
    },
    [setQueryNow, setHistory],
  );
  const onSaveChip = useCallback(
    (name: string) => {
      setSaved((cur) => [...sanitizeSavedFilters(cur), { id: `f${Date.now().toString(36)}`, name, query: queryRef.current.trim() }]);
      toast.success(t('logs.saved.saved', { name }));
    },
    [setSaved],
  );
  const onRemoveChip = useCallback((id: string) => setSaved((cur) => sanitizeSavedFilters(cur).filter((f) => f.id !== id)), [setSaved]);

  /* ───── derived UI bits ───── */
  // Store-wide counter for this scope (incremental in the store, O(sessions) here) — no timer re-render.
  const scopedTotal = useMemo(
    () => scopeLogCounts(scopeRef.current, logStore).total,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeKey, v],
  );
  const sourceCounts = useMemo(
    () => ({ device: formatCompact(snap.counts.device), app: formatCompact(snap.counts.app), system: formatCompact(snap.counts.system) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snap.counts.device, snap.counts.app, snap.counts.system, lang],
  );
  const noiseCountText = formatCompact(snap.counts.noise);

  const activeFilters: ActiveFilter[] = [];
  if (appliedQuery.trim()) activeFilters.push({ id: 'q', label: t('logs.empty.filterQuery', { query: appliedQuery.trim() }), mono: true, clear: () => setQueryNow('') });
  if (minLevel !== 'verbose') activeFilters.push({ id: 'lvl', label: t('logs.empty.filterLevel', { level: LEVEL_NAME[minLevel] }), clear: () => setMinLevel('verbose') });
  for (const s of SOURCES) if (!sources[s]) activeFilters.push({ id: `src-${s}`, label: t('logs.empty.filterSourceOff', { source: t(`logs.source.${s}`) }), clear: () => toggleSource(s) });
  if (hideNoise && snap.counts.noise > 0) activeFilters.push({ id: 'noise', label: t('logs.empty.filterNoise'), clear: () => setPref('hideNoise', false) });
  if (!showNetwork) activeFilters.push({ id: 'net', label: t('logs.empty.filterNetwork'), clear: () => setPref('showNetworkInLogs', true) });
  const filtersActive = activeFilters.some((f) => f.id !== 'net' && f.id !== 'noise') || (hideNoise && snap.counts.noise > 0);

  // Markers are global: a scope whose only rows are markers has no logs of its own yet.
  const empty = snap.count === 0 || (snap.count === snap.counts.markers && !filtersActive && scopedTotal === 0);
  const inScope = Math.max(scopedTotal, snap.counts.device + snap.counts.app + snap.counts.system);

  const detail =
    detailOpen && sel ? (
      <DetailPanel
        entry={sel.entry}
        row={selRow}
        index={selIndex}
        total={snap.count}
        d={d}
        onClose={() => setDetailOpen(false)}
        onPrev={() => move(-1)}
        onNext={() => move(1)}
        onFilter={filterBy}
        onShowInContext={(id) => revealEntry(id, { open: true })}
        onOpenNetwork={(id) => ui.focusNetwork(id)}
      />
    ) : null;

  return (
    <div className="lg-view fill">
      <LogsToolbar
        active={active}
        inputRef={inputRef}
        query={query}
        parsed={parsed}
        onQueryChange={setQueryState}
        onQuerySubmit={submitQuery}
        getSuggestData={getSuggestData}
        minLevel={minLevel}
        onMinLevel={setMinLevel}
        following={following}
        paused={paused}
        onFollow={onFollowButton}
        onTogglePause={togglePause}
        onAddMarker={onAddMarkerLabel}
        onClear={onClearButton}
        dedupe={dedupe}
        onDedupe={setDedupe}
        fold={fold}
        onFold={setFold}
        menuItems={menuItems}
      />
      <div className="lg-filterbar">
        <FilterChips query={query} saved={saved} onApply={onApplyChip} onSave={onSaveChip} onRemove={onRemoveChip} />
        <SourceFilters
          sources={sources}
          onToggleSource={toggleSource}
          sourceCounts={sourceCounts}
          hideNoise={hideNoise}
          noiseCount={snap.counts.noise}
          noiseCountText={noiseCountText}
          onToggleNoise={onToggleNoise}
        />
      </div>
      {bannerCrashes.length ? <CrashBanner crashes={bannerCrashes} appName={appName} onGoto={gotoCrash} onDismiss={dismissCrash} /> : null}
      {paused ? <PausedBar pending={snap.pending} onResume={togglePause} /> : null}
      <SplitPane id="logs.detail" sizedPane="second" defaultSize={460} minSize={340} maxSize={0.62} collapsed={detail ? null : 'second'} onOverlayDismiss={() => setDetailOpen(false)} className="lg-split">
        <div className="lg-main">
          {!empty ? <HistogramSlot model={model} version={snap.version} win={win} onJump={onHistogramJump} /> : null}
          <div className="lg-listwrap">
            {empty ? (
              <div className="lg-empty">
                {filtersActive ? (
                  <NoMatchState inScope={inScope} filters={activeFilters} onClearAll={clearFilters} noiseHidden={hideNoise && snap.counts.noise > 0} onShowNoise={() => setPref('hideNoise', false)} />
                ) : (
                  <NoLogsState scope={compiledScope.scope} device={scopeDevice} />
                )}
              </div>
            ) : (
              <LogList
                ref={listRef}
                model={model}
                version={snap.version}
                structure={snap.structure}
                d={d}
                selectedId={sel?.id ?? null}
                expanded={expanded}
                flashId={flashId}
                following={following}
                frozen={paused}
                rowHeight={rowHeight}
                measureKey={measureKey}
                active={active}
                showNetwork={showNetwork}
                onFollowChange={setFollowing}
                onRowClick={onRowClick}
                onRowAction={onRowAction}
                onRowContextMenu={onRowContextMenu}
                onRangeChange={onRangeChange}
              />
            )}
            {!empty && !following && !paused ? <NewLinesPill count={newCount} onClick={jumpToEnd} /> : null}
          </div>
        </div>
        {detail}
      </SplitPane>
      <NoiseRulesDialog open={dialog === 'noise'} onClose={() => setDialog(null)} />
      <HighlightRulesDialog open={dialog === 'highlight'} onClose={() => setDialog(null)} />
      <SavedFiltersDialog open={dialog === 'saved'} onClose={() => setDialog(null)} saved={saved} onChange={(next) => setSaved(next)} onApply={setQueryNow} />
    </div>
  );
}
