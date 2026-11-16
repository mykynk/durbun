import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import {
  ArrowDownToLine,
  Bell,
  Bookmark,
  Braces,
  Bug,
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
  Share2,
  Timer,
  Trash2,
  VolumeX,
  WrapText,
  ScrollText,
} from 'lucide-react';
import { LOG_LEVELS, type AppSession, type LogEntry, type LogLevel, type LogSource } from '@durbun/protocol';
import type { Scope } from '../../data';
import {
  ALL_SCOPE,
  DESKTOP_DEVICE_ID,
  scopeDisplayName,
  compileNoiseRules,
  getScope,
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
  scopeLogTotal,
  useScopeEvictions,
  useServerSettings,
  useStoreLimits,
  useUi,
} from '../../data';
import {
  SplitPane,
  confirm,
  copyText,
  downloadText,
  formatClock,
  formatCompact,
  isMac,
  notificationPermission,
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
import { compileLogQuery, parseLogQuery, queryMinLevel, removeTopLevelKey, type QuerySuggestData } from './query';
import './i18n';
import './logs.css';
import { RowModel } from './model/rowModel';
import { rankOf, type LogRow, type RowFilter, type SourceToggles } from './model/types';
import { buildHighlighter } from './model/highlight';
import { appIdentity, type AppIdentity } from './model/frames';
import { exportCount, exportFileName, exportJson, exportTxt } from './model/export';
import { makeTerm, normalizeQuery, PRESETS, pushHistory, sanitizeSavedFilters, toggleTerm, type QueryField, type SavedFilter } from './model/queryEdit';
import { useLiveCrashes } from './live';
import { deviceAppForEntry, sessionForEntry } from './model/appOf';
import { contextPartKeys, mergeContext, revealNeeds, type RevealContext } from './model/reveal';
import { LogList, type LogListHandle } from './components/LogList';
import { EXPAND_JSON, EXPAND_LINES, EXPAND_STACK, type DeviceMark, type RowDisplay } from './components/LogRow';
import { deviceMarks, keepCrashRelevant } from './model/devices';
import { FilterChips, LogsToolbar, SourceFilters } from './components/Toolbar';
import { DetailPanel, displayText, rowAsLines } from './components/DetailPanel';
import { ShareDialog, type LinesShareContext } from './components/ShareDialog';
import { RangeBar, SelectionBar } from './components/RangeBars';
import { DEFAULT_AROUND, inRange, rangeAround, rangeBetween, rowsAsText, type LogTimeRange } from './model/timeRange';
import { useLogsMoment, logsNav } from './nav';
import { bugReport } from '../report/store';
import { Histogram } from './components/Histogram';
import { ContextBar, CrashBanner, DroppedNote, IosScopeNote, NewLinesPill, PausedBar } from './components/Banners';
import { NoLogsState, NoMatchState, type ActiveFilter } from './components/EmptyStates';
import { ClockSkewNote, CrashRecordsNote, ExplainEmpty, NotRunningNote, crashReaderText, crashRecordsState, useIosSystemLinesHidden } from '../../sources';
import { markApplying } from './hangGuard';
import { HighlightRulesDialog, NoiseRulesDialog, SavedFiltersDialog, undoToast } from './components/RulesDialogs';

const ALL_SOURCES: SourceToggles = { device: true, app: true, system: true };
const NO_MARKS: ReadonlySet<number> = new Set();
/** Shift-click / Shift+↓ pick at most this many rows at once. */
const MAX_MARKED = 20_000;

/** The entries of rows (a merged connection row gives each of its events), oldest first. */
function rowEntries(rows: readonly LogRow[]): LogEntry[] {
  const out: LogEntry[] = [];
  for (const r of rows) {
    if (r.flap) out.push(...r.flap.events);
    else out.push(r.e);
  }
  return out.sort((a, b) => a.id - b.id);
}

/** A query that looks for crashes / ANRs (`is:crash`, `is:anr`): its empty result says whether records can be read. */
const CRASH_QUERY = /(^|\s)is:(crash|anr)\b/i;
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

function HistogramSlot({ model, version, win, onJump, onSelectRange }: { model: RowModel; version: number; win: WindowStore; onJump(ts: number): void; onSelectRange(from: number, to: number): void }) {
  const visible = useSyncExternalStore(win.subscribe, win.get, win.get);
  return <Histogram hist={model.hist} version={version} visible={visible} onJump={onJump} onSelectRange={onSelectRange} />;
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
  const userQuery = typeof queryRaw === 'string' ? queryRaw : '';
  const [userApplied, setAppliedQuery] = useState(() => {
    if (userQuery.trim()) markApplying('query');
    return userQuery;
  });
  const [minLevelRaw, setMinLevelState] = usePersistentState<LogLevel>('logs.minLevel', 'verbose');
  const userMinLevel: LogLevel = LOG_LEVELS.includes(minLevelRaw) ? minLevelRaw : 'verbose';
  const [sourcesRaw, setSourcesState] = usePersistentState<SourceToggles>('logs.sources', ALL_SOURCES);
  const userSources = useMemo(() => sanitizeSources(sourcesRaw), [sourcesRaw]);
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
  const [share, setShare] = useState<{ entries: LogEntry[]; context?: LinesShareContext } | null>(null);
  const setShareEntry = useCallback((e: LogEntry) => setShare({ entries: [e] }), []);
  /** Rows picked with Shift / ⌘-click (row ids), and the row a Shift-click extends from. */
  const [marked, setMarked] = useState<ReadonlySet<number>>(NO_MARKS);
  const markAnchor = useRef<number | null>(null);
  /** The list narrowed to a time window (never saved). */
  const [range, setRange] = useState<LogTimeRange | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const [ageTick, setAgeTick] = useState(0);
  const listRef = useRef<LogListHandle>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [win] = useState(createWindowStore);
  const [model] = useState(() => new RowModel());

  // Debounce typing: parse on every keystroke (highlighting), filter 150 ms after the last one.
  useEffect(() => {
    if (userQuery === userApplied) return;
    const id = setTimeout(() => {
      if (userQuery.trim()) markApplying('query');
      setAppliedQuery(userQuery);
    }, 150);
    return () => clearTimeout(id);
  }, [userQuery, userApplied]);
  const setQueryNow = useCallback(
    (q: string) => {
      if (q.trim()) markApplying('query');
      setQueryState(q);
      setAppliedQuery(q);
    },
    [setQueryState],
  );

  const userAppliedRef = useRef(userApplied);
  userAppliedRef.current = userApplied;

  /* ───── reveal context: filters suspended to show one line (never saved) ───── */
  const [ctx, setCtxState] = useState<RevealContext | null>(null);
  const ctxRef = useRef(ctx);
  const setCtx = useCallback((c: RevealContext | null) => {
    ctxRef.current = c;
    setCtxState(c);
  }, []);
  // What the view filters by: the user's own filters, minus the parts the context suspends.
  const query = ctx?.query ? '' : userQuery;
  const appliedQuery = ctx?.query ? '' : userApplied;
  const minLevel: LogLevel = ctx?.level ? 'verbose' : userMinLevel;
  const sources = ctx?.sources ? ALL_SOURCES : userSources;
  /** Editing a filter while in context keeps what is on screen and builds on it: the suspended parts become the filter. */
  const commitCtx = useCallback(() => {
    const c = ctxRef.current;
    if (!c) return;
    setCtx(null);
    if (c.query) setQueryNow('');
    if (c.level) setMinLevelState('verbose');
    if (c.sources) setSourcesState(ALL_SOURCES);
  }, [setCtx, setQueryNow, setMinLevelState, setSourcesState]);
  const setMinLevel = useCallback(
    (l: LogLevel) => {
      commitCtx();
      setMinLevelState(l);
    },
    [commitCtx, setMinLevelState],
  );
  const setSources = useCallback(
    (next: SourceToggles | ((cur: SourceToggles) => SourceToggles)) => {
      commitCtx();
      setSourcesState(next);
    },
    [commitCtx, setSourcesState],
  );
  const setQueryUser = useCallback(
    (q: string) => {
      commitCtx();
      setQueryNow(q);
    },
    [commitCtx, setQueryNow],
  );
  const onQueryChange = useCallback(
    (q: string) => {
      commitCtx();
      setQueryState(q);
    },
    [commitCtx, setQueryState],
  );

  /* ───── scope & apps (stats churn ignored via signatures) ───── */
  const compiledScope = useCompiledScope();
  const apps = useHub((s) => s.apps);
  const appsRef = useRef(apps);
  appsRef.current = apps;
  const appsSig = useMemo(() => appsSignature(apps), [apps]);
  // Membership signature of the scope (changes when its sessions / pids / names change, not on stats churn).
  const scopeKey = compiledScope.key;
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

  // With the server's 'apps' scope for iPhones, the daemon lines that still arrive are the crash-relevant ones
  // (a server that does not report the setting streams everything).
  const iosAppsScope = useServerSettings((s) => !!s.reported?.has('iosDeviceLogScope') && (s.settings.iosDeviceLogScope ?? 'apps') === 'apps');
  const noiseFn = useMemo(() => cachedNoise(keepCrashRelevant(compileNoiseRules(noiseRules), iosAppsScope)), [noiseRules, iosAppsScope]);
  // The prefs stay as the user set them; a reveal context only lifts them for this view.
  const effHideNoise = hideNoise && !ctx?.noise;
  const effShowNetwork = showNetwork || !!ctx?.network;

  const filter = useMemo<RowFilter>(
    () => ({
      scope: scopeFn,
      minRank: rankOf(minLevel),
      queryMinRank: queryMin ? rankOf(queryMin) : 0,
      sources,
      hideNoise: effHideNoise,
      noise: noiseFn,
      showNetwork: effShowNetwork,
      query: compiledQuery,
      dedupe,
      fold,
      range: range ? { from: range.from, to: range.to } : null,
    }),
    [scopeFn, minLevel, queryMin, sources, effHideNoise, noiseFn, effShowNetwork, compiledQuery, dedupe, fold, range],
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
  const hl = useMemo(() => {
    if (highlightRules.some((r) => r.enabled && r.regex && r.pattern)) markApplying('highlight');
    return buildHighlighter(compiledQuery.highlights, highlightRules);
  }, [compiledQuery, highlightRules]);
  const impliedProcesses = useMemo(() => {
    const s = new Set<string>();
    const kind = compiledScope.scope.kind;
    if ((kind === 'app' || kind === 'deviceApp') && compiledScope.deviceId && compiledScope.bundleId) {
      const key = `${compiledScope.deviceId}|${compiledScope.bundleId}`;
      s.add(compiledScope.bundleId);
      if (compiledScope.deviceApp?.processName) s.add(compiledScope.deviceApp.processName);
      for (const a of Object.values(appsRef.current)) {
        if (`${a.deviceId}|${a.app.id}` !== key) continue;
        s.add(a.app.id);
        if (a.app.processName) s.add(a.app.processName);
      }
    }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  // Device lines: the process is the app; ANRs / tombstones name the package in the message or data.
  const appForEntry = useCallback((e: LogEntry): AppSession | undefined => sessionForEntry(e, appsRef.current), []);

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

  const appName = useCallback(
    (e: LogEntry) => {
      const sdkName = appForEntry(e)?.app.name;
      if (sdkName) return sdkName;
      // SDK-less apps: the name the device reports (iOS display name, Android label when known).
      const da = deviceAppForEntry(e, useHub.getState().deviceApps);
      return da ? da.name || da.id : undefined;
    },
    [appForEntry],
  );

  // Several devices share the list ('all' scope): each row says which one it came from. Devices count when they
  // are online or still have lines in the buffer (a phone that just left keeps its rows).
  const hubDevices = useHub((s) => s.devices);
  const markSig = useMemo(() => {
    if (compiledScope.scope.kind !== 'all') return '';
    const ids = new Set<string>();
    for (const dv of Object.values(hubDevices)) if (dv.state === 'online' && dv.id !== DESKTOP_DEVICE_ID) ids.add(dv.id);
    for (const [id, c] of logStore.countsByDevice) if (c.total > 0 && id && id !== DESKTOP_DEVICE_ID) ids.add(id);
    if (ids.size < 2) return '';
    return [...ids]
      .sort()
      .map((id) => `${id}\t${deviceDisplayName(hubDevices[id], id)}`)
      .join('\n');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiledScope.scope.kind, hubDevices, v, lang]);
  const deviceMark = useMemo(() => {
    if (!markSig) return undefined;
    const marks = deviceMarks(
      markSig.split('\n').map((line) => {
        const tab = line.indexOf('\t');
        return { id: line.slice(0, tab), name: line.slice(tab + 1) };
      }),
    );
    return (e: LogEntry): DeviceMark | undefined => marks.get(e.deviceId);
  }, [markSig]);

  // Device names for texts that name the device in any scope (a merged connection row): keyed on the names only.
  const namesSig = useMemo(
    () =>
      Object.values(hubDevices)
        .map((dv) => `${dv.id}\t${deviceDisplayName(dv)}`)
        .sort()
        .join('\n'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hubDevices, lang],
  );
  const deviceName = useMemo(() => {
    const names = new Map<string, string>();
    for (const line of namesSig ? namesSig.split('\n') : []) {
      const tab = line.indexOf('\t');
      names.set(line.slice(0, tab), line.slice(tab + 1));
    }
    return (id: string): string | undefined => names.get(id) || undefined;
  }, [namesSig]);

  const d = useMemo<RowDisplay>(
    () => ({ timeFormat, wrap: wrapLines, lang, hl, impliedProcesses, identity, appName, device: deviceMark, deviceName }),
    [timeFormat, wrapLines, lang, hl, impliedProcesses, identity, appName, deviceMark, deviceName],
  );
  const rowHeight = Math.max(density === 'comfortable' ? 24 : 20, Math.round(fontSize * 1.45));
  const measureKey = `${fontSize}|${density}|${wrapLines}`;

  /* ───── selection ───── */
  const selIndex = sel ? model.indexOfRow(sel.id) : -1;
  const selRow = selIndex >= 0 ? model.row(selIndex) : undefined;

  const selectRow = useCallback((row: LogRow, open: boolean) => {
    setSel({ id: row.id, entry: row.e });
    markAnchor.current = row.id;
    if (open) setDetailOpen(true);
  }, []);

  /** Pick the rows between the anchor and `index` (Shift-click, Shift+↑/↓); `add` keeps the rows picked before. */
  const markTo = useCallback(
    (index: number, add: boolean) => {
      const anchorId = markAnchor.current ?? sel?.id ?? null;
      let a = anchorId !== null ? model.indexOfRow(anchorId) : -1;
      if (a < 0) a = index;
      const from = Math.max(Math.min(a, index), Math.max(a, index) - MAX_MARKED + 1);
      const to = Math.max(a, index);
      setMarked((cur) => {
        const next = new Set(add ? cur : NO_MARKS);
        for (let i = from; i <= to; i++) {
          const r = model.row(i);
          if (r) next.add(r.id);
        }
        return next;
      });
      if (anchorId === null) markAnchor.current = model.row(a)?.id ?? null;
    },
    [model, sel],
  );

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
      markAnchor.current = row.id;
      setMarked(NO_MARKS);
      setFollowing(false);
      listRef.current?.scrollToIndex(next, 'auto');
    },
    [model, sel, setFollowing],
  );

  /** Shift+↑/↓: grow (or shrink) the picked rows from the anchor. */
  const extend = useCallback(
    (delta: number) => {
      if (model.count === 0) return;
      const idx = sel ? model.indexOfRow(sel.id) : -1;
      if (idx < 0) {
        move(delta);
        return;
      }
      if (markAnchor.current === null || model.indexOfRow(markAnchor.current) < 0) markAnchor.current = sel!.id;
      const next = Math.max(0, Math.min(model.count - 1, idx + delta));
      const row = model.row(next);
      if (!row) return;
      markTo(next, false);
      setSel({ id: row.id, entry: row.e });
      setFollowing(false);
      listRef.current?.scrollToIndex(next, 'auto');
    },
    [model, sel, move, markTo, setFollowing],
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
    setQueryUser('');
    setMinLevel('verbose');
    setSources(ALL_SOURCES);
  }, [setQueryUser, setMinLevel, setSources]);
  // Explicit choices about noise / network lines (they write the prefs, as the toolbar and Settings do).
  const setNoiseHidden = useCallback(
    (hidden: boolean) => {
      commitCtx();
      usePrefs.getState().setPref('hideNoise', hidden);
    },
    [commitCtx],
  );
  const setNetworkShown = useCallback(
    (shown: boolean) => {
      commitCtx();
      usePrefs.getState().setPref('showNetworkInLogs', shown);
    },
    [commitCtx],
  );

  /** The level control: a level condition in the query goes with it, so the two never disagree. */
  const pickLevel = useCallback(
    (l: LogLevel) => {
      if (queryMin) {
        const q = removeTopLevelKey(query, 'level');
        if (q !== query) setQueryUser(q);
      }
      setMinLevel(l);
    },
    [queryMin, query, setQueryUser, setMinLevel],
  );

  const applyTerm = useCallback((term: string) => setQueryUser(toggleTerm(query, term)), [query, setQueryUser]);
  const filterBy = useCallback((field: QueryField, value: string | number, exclude: boolean) => applyTerm(makeTerm(field, value, { exclude })), [applyTerm]);

  const submitQuery = useCallback(
    (q: string) => {
      commitCtx();
      if (q.trim()) markApplying('query');
      setAppliedQuery(q);
      if (q.trim()) setHistory((h) => pushHistory(Array.isArray(h) ? h : [], q));
    },
    [setHistory, commitCtx],
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
    (entryId: number, opts: { open?: boolean; anyScope?: boolean; context?: boolean } = {}) => {
      const e = logStore.getById(entryId) ?? (sel?.entry.id === entryId ? sel.entry : undefined);
      if (!e) {
        toast.info(t('logs.reveal.gone'));
        return;
      }
      // A time window that leaves the line out goes (the user asked for this line).
      if (rangeRef.current && !inRange(rangeRef.current, e.ts)) setRange(null);
      setMarked(NO_MARKS);
      // Outside the scope (a jump from another tab, a notification): all devices, and "Back" returns to the scope.
      let leftScope: Scope | undefined;
      if (opts.anyScope && !scopeRef.current.logs(e)) {
        leftScope = getScope();
        setScope(ALL_SCOPE);
      }
      // Only the filters that hide this line are suspended, for this view only: the saved query, level, sources
      // and the noise / network prefs stay as the user set them (the context bar offers the way back). "Show in
      // context" (`context`) also suspends the query, level and sources filters that hide the lines around it.
      if (leftScope || opts.context || model.indexOfEntry(entryId) < 0) {
        const own = parseLogQuery(userAppliedRef.current);
        const ownMin = queryMinLevel(own);
        const needs = revealNeeds(e, {
          minRank: rankOf(userMinLevel),
          queryMinRank: ownMin ? rankOf(ownMin) : 0,
          sources: userSources,
          hideNoise,
          noise: noiseFn,
          showNetwork,
          query: compileLogQuery(own, { now: Date.now(), apps: appsRef.current }),
        });
        if (opts.context) {
          needs.query ||= userAppliedRef.current.trim() !== '';
          needs.level ||= userMinLevel !== 'verbose';
          needs.sources ||= Object.values(userSources).some((on) => on === false);
        }
        const next = mergeContext(ctxRef.current, needs, leftScope);
        if (next !== ctxRef.current) setCtx(next);
      }
      setPaused(false);
      setFollowing(false);
      setSel({ id: entryId, entry: e });
      if (opts.open) setDetailOpen(true);
      pendingReveal.current = { id: entryId, build: model.build, tries: 0, open: !!opts.open };
      setRevealTick((x) => x + 1);
    },
    [model, sel, noiseFn, userMinLevel, userSources, hideNoise, showNetwork, setCtx, setFollowing],
  );

  /** "Back to my filters": the suspended filters apply again, and a scope the jump left comes back. */
  const leaveContext = useCallback(() => {
    const c = ctxRef.current;
    if (!c) return;
    setCtx(null);
    if (c.scope && getScope().kind === 'all') setScope(c.scope);
  }, [setCtx]);

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
    (row: LogRow, index: number, ev: MouseEvent) => {
      const mod = isMac ? ev.metaKey : ev.ctrlKey;
      if (ev.shiftKey) {
        markTo(index, mod);
        setSel({ id: row.id, entry: row.e });
        setFollowing(false);
        return;
      }
      if (mod) {
        setMarked((cur) => {
          const next = new Set(cur);
          // The row already selected is the first pick.
          if (next.size === 0 && sel && sel.id !== row.id && model.indexOfRow(sel.id) >= 0) next.add(sel.id);
          if (next.has(row.id)) next.delete(row.id);
          else next.add(row.id);
          return next;
        });
        markAnchor.current = row.id;
        setSel({ id: row.id, entry: row.e });
        setFollowing(false);
        return;
      }
      setMarked(NO_MARKS);
      selectRow(row, true);
    },
    [selectRow, markTo, sel, model, setFollowing],
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
          // A merged connection row keeps its expansion while it moves down with each new event.
          toggleExpand(row.flap?.key ?? row.id, EXPAND_LINES);
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
      const picked = marked.size > 1 && marked.has(row.id);
      if (!picked && marked.size) setMarked(NO_MARKS);
      if (picked) setSel({ id: row.id, entry: row.e });
      else selectRow(row, false);
      const items: MenuItem[] = [];
      if (picked) {
        items.push({ label: t('logs.ctx.copySelected', { count: marked.size }), icon: Copy, shortcut: 'Mod+C', onSelect: () => void copyMarked() });
        items.push({ label: t('logs.ctx.shareSelected', { count: marked.size }), icon: Share2, onSelect: shareMarked });
        items.push({ type: 'separator' });
      }
      items.push(
        { label: t('logs.ctx.copyMessage'), icon: Copy, onSelect: () => void copy(displayText(e)) },
        { label: t('logs.ctx.copyLine'), onSelect: () => void copy(rowAsLines(row)) },
        { label: t('logs.ctx.copyJson'), icon: Braces, onSelect: () => void copy(JSON.stringify(e, null, 2)) },
        { label: t('logs.share.menu'), icon: Share2, onSelect: () => setShareEntry(e) },
        { label: t('report.openEllipsis'), icon: Bug, onSelect: () => bugReport.open({ kind: 'log', logId: e.id }) },
        { type: 'separator' },
      );
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
      items.push({ label: t('logs.ctx.showInContext'), icon: LocateFixed, onSelect: () => revealEntry(e.id, { open: true, context: true }) });
      items.push({ label: t('logs.ctx.around'), icon: Timer, onSelect: () => showAround(e.id) });
      if (e.kind === 'network' && e.netId && networkStore.get(e.netId)) items.push({ label: t('logs.ctx.openNetwork'), icon: ExternalLink, onSelect: () => ui.focusNetwork(e.netId!) });
      openContextMenu(ev, items);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [copy, filterBy, revealEntry, selectRow, marked],
  );

  // The top of the list is on screen: where the user looks for older lines (the memory-limit note shows there).
  const [atTop, setAtTop] = useState(true);
  const onRangeChange = useCallback(
    (first: number, last: number) => {
      setAtTop(first === 0);
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

  /* ───── time range ("the moments around this line", Shift-drag on the histogram) ───── */
  /** Narrow the list to ±half around a line, with every line of the scope (filters suspended, as "Show in context"). */
  const showAround = useCallback(
    (entryId: number, half: number = DEFAULT_AROUND) => {
      const e = logStore.getById(entryId) ?? (sel?.entry.id === entryId ? sel.entry : undefined);
      if (!e) {
        toast.info(t('logs.reveal.gone'));
        return;
      }
      revealEntry(entryId, { context: true, open: detailOpen });
      setRange(rangeAround(e, half));
    },
    [sel, revealEntry, detailOpen],
  );
  const onRangeStep = useCallback((half: number) => {
    const r = rangeRef.current;
    if (!r?.anchor) return;
    setRange({ from: r.anchor.ts - half, to: r.anchor.ts + half, anchor: r.anchor, half });
  }, []);
  const onHistogramRange = useCallback(
    (from: number, to: number) => {
      setRange(rangeBetween(from, to));
      setMarked(NO_MARKS);
      setFollowing(false);
    },
    [setFollowing],
  );
  const clearRange = useCallback(() => setRange(null), []);

  /** A jump by time from another tab (a request whose own line was dropped): the moments around it. */
  /* ── what the limits deleted from this view (server counts, or this window's own trims with the dev mock) ── */
  const evictions = useScopeEvictions();
  const storeLimits = useStoreLimits((s) => s.limits);
  const logLimit = storeLimits?.maxLogEntries ?? logStore.maxEntries;

  const moment = useLogsMoment();
  const momentHandled = useRef(0);
  useEffect(() => {
    if (!moment || momentHandled.current === moment.seq) return;
    momentHandled.current = moment.seq;
    logsNav.consume(moment.seq);
    // The line closest in time, preferring the request's app / device (the ring is in arrival order, close to time order).
    let best: LogEntry | undefined;
    let bestScore = Infinity;
    const entries = logStore.entries;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      const dt = Math.abs(e.ts - moment.ts);
      if (dt > DEFAULT_AROUND) {
        if (e.ts < moment.ts - 10 * DEFAULT_AROUND) break;
        continue;
      }
      const score = dt + (moment.appId && e.appId === moment.appId ? 0 : moment.deviceId && e.deviceId === moment.deviceId ? 5_000 : 20_000);
      if (score < bestScore) {
        best = e;
        bestScore = score;
      }
    }
    if (!best) {
      toast.info(t('logs.jump.noneTitle'), { description: t('logs.jump.noneBody', { time: formatClock(moment.ts) }) });
      return;
    }
    revealEntry(best.id, { anyScope: true, context: true });
    setRange({ from: moment.ts - DEFAULT_AROUND, to: moment.ts + DEFAULT_AROUND, anchor: { id: best.id, ts: moment.ts }, half: DEFAULT_AROUND });
    toast.info(t('logs.jump.title'), { description: t('logs.jump.body', { time: formatClock(moment.ts) }) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moment?.seq]);

  /* ───── picked rows: copy, share ───── */
  const markedRows = useCallback((): LogRow[] => {
    const out: LogRow[] = [];
    if (marked.size === 0) return out;
    for (let i = 0; i < model.count; i++) {
      const r = model.row(i)!;
      if (marked.has(r.id)) out.push(r);
    }
    return out;
  }, [marked, model]);
  const copyRows = useCallback(async (rows: readonly LogRow[], doneKey: string) => {
    if (rows.length === 0) {
      toast.info(t('logs.selection.gone'));
      return;
    }
    const ok = await copyText(rowsAsText(rows, { text: displayText }));
    if (ok) toast.success(t(doneKey, { count: rows.length }));
    else toast.error(t('common.copyFailed'));
  }, []);
  const copyMarked = useCallback(() => copyRows(markedRows(), 'logs.selection.copied'), [copyRows, markedRows]);
  const shareMarked = useCallback(() => {
    const rows = markedRows();
    if (rows.length === 0) {
      toast.info(t('logs.selection.gone'));
      return;
    }
    setShare({ entries: rowEntries(rows), context: { scope: scopeDisplayName(scopeRef.current.scope, useHub.getState()), origin: t('logs.selection.label') } });
  }, [markedRows]);
  const rangeRows = useCallback((): LogRow[] => model.rows.slice(model.start), [model]);
  const copyRange = useCallback(() => copyRows(rangeRows(), 'logs.range.copied'), [copyRows, rangeRows]);
  const shareRange = useCallback(() => {
    const r = rangeRef.current;
    const rows = rangeRows();
    if (!r || rows.length === 0) return;
    const ms = r.to - r.from < 10_000;
    setShare({
      entries: rowEntries(rows),
      context: { scope: scopeDisplayName(scopeRef.current.scope, useHub.getState()), origin: t('logs.range.title', { from: formatClock(r.from, { ms }), to: formatClock(r.to, { ms }) }) },
    });
  }, [rangeRows]);
  /** Picked rows that span a stretch of time: show only that stretch. */
  const rangeOfMarked = useCallback(() => {
    const rows = markedRows();
    if (rows.length < 2) return;
    setRange(rangeBetween(rows[0]!.e.ts, (rows[rows.length - 1]!.last ?? rows[rows.length - 1]!.e).ts));
    setMarked(NO_MARKS);
  }, [markedRows]);
  const markedSpan = useMemo(() => {
    if (marked.size < 2) return 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const id of marked) {
      const e = logStore.getById(id);
      if (!e) continue;
      if (e.ts < lo) lo = e.ts;
      if (e.ts > hi) hi = e.ts;
    }
    return hi > lo ? hi - lo : 0;
  }, [marked]);

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
        // Same wording as the Network tab's clear: what goes, how much, and that it cannot be undone.
        // An app scope's clear removes its device lines too: count them as the list shows them.
        const count = scopeLogTotal(cs, logStore);
        const message =
          scope.kind === 'all'
            ? t('logs.clear.all', { count })
            : scope.kind === 'device'
              ? t('logs.clear.device', { count, name: deviceDisplayName(useHub.getState().devices[scope.deviceId], scope.deviceId) })
              : t('logs.clear.app', { count, name: cs.app?.app.name || cs.deviceApp?.name || (scope.kind === 'app' ? scope.appId : scope.bundleId) });
        const ok = await confirm({ title: t('logs.clear.title'), message, confirmLabel: t('logs.clear.confirm'), danger: true, icon: Trash2 });
        if (!ok) return;
      }
      try {
        // App scopes clear what the view shows: the server matches the device lines of the app's processes the
        // way the scope does (one app of the device, or one session and its process when exact).
        if (scope.kind === 'all') await sendCommand({ name: 'clear', target: 'logs' });
        else if (scope.kind === 'device') await sendCommand({ name: 'clear', target: 'logs', deviceId: scope.deviceId });
        else if (scope.kind === 'app' && scope.exact) await sendCommand({ name: 'clear', target: 'logs', deviceId: cs.deviceId, appId: scope.appId });
        else if (cs.deviceId && cs.bundleId) await sendCommand({ name: 'clear', target: 'logs', deviceId: cs.deviceId, bundleId: cs.bundleId });
        else if (scope.kind === 'app') await sendCommand({ name: 'clear', target: 'logs', appId: scope.appId });
        setPaused(false);
        setSel(null);
        setMarked(NO_MARKS);
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
    if (cs.scope.kind === 'deviceApp') {
      const name = cs.app?.app.name || cs.deviceApp?.name || cs.scope.bundleId;
      return `${name} · ${deviceDisplayName(useHub.getState().devices[cs.scope.deviceId], cs.scope.deviceId)}`;
    }
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
        const count = exportCount(rows);
        if (fmt === 'txt') {
          const header = [t('logs.export.headerTitle'), t('logs.export.headerScope', { scope }), t('logs.export.headerRows', { count })];
          if (appliedQuery.trim()) header.push(t('logs.export.headerQuery', { query: appliedQuery.trim() }));
          downloadText(exportTxt(rows, { text: displayText, header }), exportFileName('txt'));
        } else {
          downloadText(exportJson(rows, { exportedAt: new Date().toISOString(), scope, query: appliedQuery.trim() || undefined }), exportFileName('json'), 'application/json');
        }
        toast.success(t('logs.export.done', { count }));
      } catch (err) {
        toast.error(errorText(err));
      }
    },
    [model, scopeLabel, appliedQuery],
  );

  /* ───── crashes ───── */
  // The banner shows the scope's live crashes; desktop notifications cover every device from the shell
  // (shell/crashNotify.ts), whichever tab is open.
  const [crashState, dismissCrash] = useLiveCrashes(scopeFn, scopeKey);
  const bannerCrashes = useMemo(() => crashState.list.filter((e) => e.id > crashState.dismissedId), [crashState]);
  const gotoCrash = useCallback(
    (e: LogEntry) => {
      dismissCrash(e.id);
      revealEntry(e.id, { open: true });
    },
    [dismissCrash, revealEntry],
  );
  // "Report a bug" from the banner: the crash line opens behind the dialog, so it is there when the report is done.
  const reportCrash = useCallback(
    (e: LogEntry) => {
      revealEntry(e.id, { open: true });
      bugReport.open({ kind: 'log', logId: e.id });
    },
    [revealEntry],
  );
  const gotoLatestCrash = useCallback(() => {
    const scope = scopeRef.current.logs;
    // The ring plus the crash records it keeps after a flood (`logStore.kept`): the counters include them too.
    const latest = logStore.findLast((e) => isCrashEntry(e) && scope(e));
    if (latest) {
      revealEntry(latest.id, { open: true });
      return;
    }
    // "No crash" is only true when the scoped devices' own crash records can be read.
    const unreadable = crashRecordsState(scopeRef.current.scope, useHub.getState()).unreadable;
    if (unreadable.length > 0) toast.info(t('sources.crashEmpty.toastTitle'), { description: [t('sources.crashEmpty.unreadableLead'), ...unreadable.map(crashReaderText)].join(' ') });
    else toast.info(t('logs.crash.none'));
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
  useShortcut(['Shift+ArrowDown', 'Shift+J'], () => extend(1), { enabled: active, allowRepeat: true });
  useShortcut(['Shift+ArrowUp', 'Shift+K'], () => extend(-1), { enabled: active, allowRepeat: true });
  useShortcut(
    'Mod+C',
    (e) => {
      // Text the user selected, or a field, keeps the normal copy.
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, [contenteditable="true"]')) return false;
      const s = window.getSelection();
      if (s && !s.isCollapsed && s.toString()) return false;
      void copyMarked();
    },
    { enabled: active && marked.size > 0 },
  );
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
      if (marked.size) {
        setMarked(NO_MARKS);
        return;
      }
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
    { id: 'logs.noise', title: effHideNoise ? t('logs.cmd.showNoise') : t('logs.cmd.hideNoise'), group, icon: VolumeX, keywords: ['noise', 'gürültü', 'gurultu'], run: () => setNoiseHidden(!effHideNoise) },
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
    ...(range ? [{ id: 'logs.range.clear', title: t('logs.cmd.clearRange'), group, icon: Timer, keywords: ['range', 'aralık', 'time', 'zaman'], run: clearRange }] : []),
    ...(marked.size > 0
      ? [
          { id: 'logs.marked.copy', title: t('logs.cmd.copySelected'), subtitle: t('logs.selection.count', { count: marked.size }), group, icon: Copy, shortcut: 'Mod+C', keywords: ['copy', 'kopyala', 'selected', 'seçili'], run: () => void copyMarked() },
          { id: 'logs.marked.share', title: t('logs.cmd.shareSelected'), subtitle: t('logs.selection.count', { count: marked.size }), group, icon: Share2, keywords: ['share', 'paylaş', 'slack', 'selected', 'seçili'], run: shareMarked },
        ]
      : []),
    ...(sel
      ? [
          { id: 'logs.sel.around', title: t('logs.cmd.around'), group, icon: Timer, keywords: ['around', 'çevre', 'context', 'bağlam', 'time', 'zaman', 'range', 'aralık'], run: () => { ui.setTab('logs'); showAround(sel.entry.id); } },
          { id: 'logs.sel.share', title: t('logs.share.title'), group, icon: Share2, keywords: ['share', 'paylaş', 'slack', 'report', 'rapor'], run: () => setShareEntry(sel.entry) },
          { id: 'logs.sel.report', title: t('logs.cmd.reportLine'), group, icon: Bug, keywords: ['bug', 'hata', 'report', 'rapor', 'zip', 'jira'], run: () => bugReport.open({ kind: 'log', logId: sel.entry.id }) },
        ]
      : []),
  ]);

  /* ───── stable callbacks for the memoized toolbar / chips ───── */
  const hideNoiseRef = useRef(effHideNoise);
  hideNoiseRef.current = effHideNoise;
  const onToggleNoise = useCallback(() => setNoiseHidden(!hideNoiseRef.current), [setNoiseHidden]);
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
      setQueryUser(q);
      if (q) setHistory((h) => pushHistory(Array.isArray(h) ? h : [], q));
    },
    [setQueryUser, setHistory],
  );
  const onSaveChip = useCallback(
    (name: string) => {
      setSaved((cur) => [...sanitizeSavedFilters(cur), { id: `f${Date.now().toString(36)}`, name, query: queryRef.current.trim() }]);
      toast.success(t('logs.saved.saved', { name }));
    },
    [setSaved],
  );
  const onRemoveChip = useCallback(
    (id: string) => {
      const before = sanitizeSavedFilters(savedRaw);
      const gone = before.find((f) => f.id === id);
      setSaved(before.filter((f) => f.id !== id));
      if (gone) undoToast(t('logs.saved.removed', { name: gone.name }), () => setSaved(before));
    },
    [setSaved, savedRaw, t],
  );

  /* ───── scope notes ───── */
  // Physical iPhones whose system-process lines the server leaves out ('apps' log scope): said once.
  const hiddenIphones = useIosSystemLinesHidden();
  const [iosNoteSeen, setIosNoteSeen] = usePersistentState<boolean>('logs.iosScopeNote', false);
  const iosPhones = iosNoteSeen === true ? [] : hiddenIphones;

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
  if (appliedQuery.trim()) activeFilters.push({ id: 'q', label: t('logs.empty.filterQuery', { query: appliedQuery.trim() }), mono: true, clear: () => setQueryUser('') });
  if (minLevel !== 'verbose') activeFilters.push({ id: 'lvl', label: t('logs.empty.filterLevel', { level: LEVEL_NAME[minLevel] }), clear: () => setMinLevel('verbose') });
  for (const s of SOURCES) if (!sources[s]) activeFilters.push({ id: `src-${s}`, label: t('logs.empty.filterSourceOff', { source: t(`logs.source.${s}`) }), clear: () => toggleSource(s) });
  if (effHideNoise && snap.counts.noise > 0) activeFilters.push({ id: 'noise', label: t('logs.empty.filterNoise'), clear: () => setNoiseHidden(false) });
  if (!effShowNetwork) activeFilters.push({ id: 'net', label: t('logs.empty.filterNetwork'), clear: () => setNetworkShown(true) });
  const filtersActive = activeFilters.some((f) => f.id !== 'net' && f.id !== 'noise') || (effHideNoise && snap.counts.noise > 0);

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
        onShowInContext={(id) => revealEntry(id, { open: true, context: true })}
        onShowAround={(id) => showAround(id)}
        onOpenNetwork={(id) => ui.focusNetwork(id)}
        onShare={() => setShareEntry(sel.entry)}
        onReport={() => bugReport.open({ kind: 'log', logId: sel.entry.id })}
      />
    ) : null;

  return (
    <div className="lg-view fill">
      <LogsToolbar
        active={active}
        inputRef={inputRef}
        query={query}
        parsed={parsed}
        onQueryChange={onQueryChange}
        onQuerySubmit={submitQuery}
        getSuggestData={getSuggestData}
        minLevel={minLevel}
        queryLevel={queryMin}
        onMinLevel={pickLevel}
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
          hideNoise={effHideNoise}
          noiseCount={snap.counts.noise}
          noiseCountText={noiseCountText}
          onToggleNoise={onToggleNoise}
        />
      </div>
      {bannerCrashes.length ? <CrashBanner crashes={bannerCrashes} appName={appName} device={deviceMark} onGoto={gotoCrash} onReport={reportCrash} onDismiss={dismissCrash} /> : null}
      {paused ? <PausedBar pending={snap.pending} onResume={togglePause} /> : null}
      {range ? <RangeBar range={range} count={snap.count} lang={lang} onStep={onRangeStep} onCopy={() => void copyRange()} onShare={shareRange} onClear={clearRange} /> : null}
      {marked.size > 1 ? <SelectionBar count={marked.size} spanMs={markedSpan} onCopy={() => void copyMarked()} onShare={shareMarked} onAround={markedSpan > 0 ? rangeOfMarked : undefined} onClear={() => setMarked(NO_MARKS)} /> : null}
      {ctx ? <ContextBar parts={contextPartKeys(ctx)} queryName={ctx.query ? queryChipName(userApplied, saved) : undefined} scopeName={ctx.scope ? scopeDisplayName(ctx.scope, useHub.getState()) : undefined} onBack={leaveContext} /> : null}
      {!empty && atTop && (evictions.logs > 0 || logStore.size >= logLimit) ? (
        <DroppedNote
          dropped={evictions.logs}
          limit={logLimit}
          memoryLimit={storeLimits?.maxLogBytes}
          byMemory={evictions.logsByMemory}
          since={model.row(0)?.e.ts}
          onOpenSettings={() => ui.openSettings('logs')}
        />
      ) : null}
      {iosPhones.length > 0 ? (
        <IosScopeNote device={iosPhones.length === 1 ? deviceDisplayName(iosPhones[0]) : undefined} onOpenSettings={() => ui.openSettings('logs')} onDismiss={() => setIosNoteSeen(true)} />
      ) : null}
      {/* The scoped app is closed but the list is not empty (its earlier lines, the device's own separators): say why
          nothing new arrives and offer to launch it. An empty list says the same in its empty state. */}
      {!empty ? <NotRunningNote capability="logs" className="lg-idle" /> : null}
      {/* App lines carry the device's time: say so when that clock is far from the Mac's. */}
      {!empty ? <ClockSkewNote session={compiledScope.app} className="lg-clock" /> : null}
      <SplitPane id="logs.detail" sizedPane="second" defaultSize={460} minSize={340} maxSize={0.62} collapsed={detail ? null : 'second'} onOverlayDismiss={() => setDetailOpen(false)} className="lg-split">
        <div className="lg-main">
          {!empty ? <HistogramSlot model={model} version={snap.version} win={win} onJump={onHistogramJump} onSelectRange={onHistogramRange} /> : null}
          <div className="lg-listwrap">
            {empty ? (
              <div className="lg-empty">
                {filtersActive ? (
                  <NoMatchState inScope={inScope} filters={activeFilters} onClearAll={clearFilters} noiseHidden={effHideNoise && snap.counts.noise > 0} onShowNoise={() => setNoiseHidden(false)}>
                    {CRASH_QUERY.test(appliedQuery) ? <CrashRecordsNote className="lg-empty__crash" /> : null}
                  </NoMatchState>
                ) : (
                  <ExplainEmpty
                    capability="logs"
                    icon={ScrollText}
                    fallback={
                      <NoLogsState scope={compiledScope.scope} device={scopeDevice}>
                        <CrashRecordsNote onlyProblems className="lg-empty__crash" />
                      </NoLogsState>
                    }
                  >
                    <CrashRecordsNote onlyProblems className="lg-empty__crash" />
                  </ExplainEmpty>
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
                marked={marked}
                expanded={expanded}
                flashId={flashId}
                following={following}
                frozen={paused}
                rowHeight={rowHeight}
                measureKey={measureKey}
                active={active}
                showNetwork={effShowNetwork}
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
      {share ? <ShareDialog entries={share.entries} context={share.context} onClose={() => setShare(null)} /> : null}
      <NoiseRulesDialog open={dialog === 'noise'} onClose={() => setDialog(null)} keepsCrashLines={iosAppsScope && hiddenIphones.length > 0} />
      <HighlightRulesDialog open={dialog === 'highlight'} onClose={() => setDialog(null)} />
      <SavedFiltersDialog open={dialog === 'saved'} onClose={() => setDialog(null)} saved={saved} onChange={(next) => setSaved(next)} onApply={setQueryUser} />
    </div>
  );
}

/** The chip's name when the applied query is a quick filter or a saved filter (the user pressed it, typed nothing). */
function queryChipName(applied: string, saved: readonly SavedFilter[]): string | undefined {
  const q = normalizeQuery(applied);
  if (!q) return undefined;
  const preset = PRESETS.find((p) => normalizeQuery(p.query) === q);
  if (preset) return t(preset.labelKey);
  return saved.find((f) => normalizeQuery(f.query) === q)?.name;
}
