import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChartLine, CircleStop, Clock, Cpu, FileDown, Gauge, Pause, Play, Table2 } from 'lucide-react';
import type { LogEntry } from '@durbun/protocol';
import { metricSeriesKey, metricsStore, ui, useHub, useScope, type Scope } from '../../data';
import {
  Button,
  Callout,
  EmptyState,
  IconButton,
  SegmentedControl,
  Spinner,
  StatusDot,
  Toolbar,
  ToolbarSeparator,
  ToolbarSpacer,
  downloadText,
  formatBytes,
  formatClock,
  formatNumber,
  formatPercent,
  formatRelative,
  toast,
  useCommands,
  useFeatureActive,
  usePersistentState,
  useShortcut,
} from '../../components';
import { useLanguage, useT } from '../../i18n';
import { describeError } from '../device/codes';
import { ExplainEmpty, mainPidOf, useScopeExplain } from '../../sources';
import { requestDeviceSection } from '../device/request';
import './i18n';
import './perf.css';
import {
  PERF_WINDOWS,
  appsStructureKey,
  canPoll,
  csvFileName,
  defaultTarget,
  hasMetricsCapability,
  isPerfWindow,
  perSecondRows,
  rowsToCsv,
  targetKey,
  targetSessions,
  type MetricField,
  type PerfTarget,
  type PerfWindow,
} from './model';
import { consumePerfRequest, usePerfRequest } from './request';
import { useChartColors } from './theme';
import { TimeChart, type ChartSeriesSpec, type PlotRect } from './TimeChart';
import { EventLane } from './EventLane';
import { StatTile } from './StatTiles';
import { PickerButton, TargetPicker, buildOptions } from './TargetPicker';
import { PerfTable } from './PerfTable';
import { annotationText, usePerfData } from './usePerfData';
import { acquireWatch, watchKey, type WatchSpec } from './watch';
import type { AnnotationType } from './traffic';

const SYNC_KEY = 'durbun-perf';

function scopeKeyOf(scope: Scope): string {
  if (scope.kind === 'all') return 'all';
  if (scope.kind === 'device') return `d:${scope.deviceId}`;
  if (scope.kind === 'deviceApp') return `da:${scope.deviceId}|${scope.bundleId}`;
  return `a:${scope.appId}`;
}

function without(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (!set.has(key)) return set;
  const next = new Set(set);
  next.delete(key);
  return next;
}

function withKey(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (set.has(key)) return set;
  return new Set(set).add(key);
}

export default function PerfView() {
  const t = useT();
  const lang = useLanguage();
  const active = useFeatureActive();
  const scope = useScope();
  // Re-render on structural app changes only (not on every stats bump).
  const appsKey = useHub((s) => appsStructureKey(s.apps));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const apps = useMemo(() => useHub.getState().apps, [appsKey]);
  const devices = useHub((s) => s.devices);
  const processes = useHub((s) => s.processes);
  const colors = useChartColors();
  const scopeExplain = useScopeExplain();

  const [storedWindow, setWindow] = usePersistentState<PerfWindow>('perf.window', '5m');
  const win: PerfWindow = isPerfWindow(storedWindow) ? storedWindow : '5m';
  const [storedView, setView] = usePersistentState<'charts' | 'table'>('perf.view', 'charts');
  const view = storedView === 'table' ? 'table' : 'charts';
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerProcesses, setPickerProcesses] = useState(false);
  const pickerBtn = useRef<HTMLButtonElement>(null);
  const [plotRect, setPlotRect] = useState<PlotRect | null>(null);

  /* ───────────── Target ───────────── */
  const scopeKey = scopeKeyOf(scope);
  const [picked, setPicked] = useState<{ scopeKey: string; target: PerfTarget; auto?: boolean } | null>(null);
  const fallback = useMemo(
    () => defaultTarget(scope, apps, (a) => (metricsStore.get(metricSeriesKey({ deviceId: a.deviceId, appId: a.id }))?.samples.length ?? 0) > 0),
    [scope, apps],
  );
  const fallbackKey = targetKey(fallback);
  // The automatic choice is sticky: another app (re)connecting must not steal the view while the shown app is
  // still connected. An explicit pick always wins until the scope changes.
  useEffect(() => {
    setPicked((p) => {
      const same = p !== null && p.scopeKey === scopeKey;
      if (same && !p.auto) return p;
      if (!fallback) return same ? p : null;
      if (same && p.auto) {
        const cur = p.target;
        const stillLive =
          cur.kind === 'app' && Object.values(useHub.getState().apps).some((a) => a.connected && a.deviceId === cur.deviceId && a.app.id === cur.bundleId);
        if (stillLive || targetKey(cur) === fallbackKey) return p;
      }
      return { scopeKey, target: fallback, auto: true };
    });
    // fallback is represented by fallbackKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, fallbackKey]);
  const target = picked && picked.scopeKey === scopeKey ? picked.target : fallback;
  const tKey = targetKey(target);
  const sessions = useMemo(() => targetSessions(target, apps), [target, apps]);
  const latest = sessions[0];
  const device = target ? devices[target.deviceId] : undefined;
  const flutterLike = sessions.some((s) => s.sdk.platform === 'flutter' || s.sdk.platform === 'dart-vm');

  const selectTarget = useCallback(
    (next: PerfTarget) => {
      setPicked({ scopeKey, target: next });
      if (next.kind === 'process') setPollOff((s) => without(s, targetKey(next)));
    },
    [scopeKey],
  );

  // "Performansı izle" from the Device tab.
  const request = usePerfRequest((s) => s.req);
  useEffect(() => {
    if (!request) return;
    setPicked({ scopeKey, target: request.target });
    if (request.target.kind === 'process' && request.poll) setPollOff((s) => without(s, targetKey(request.target)));
    consumePerfRequest(request.seq);
    // handle each request once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.seq]);

  /* ───────────── Polling ───────────── */
  // Process targets poll by default (picking one is the intent); the user can stop it. App targets can
  // add process polling to fill CPU/memory the SDK does not send.
  const [pollOff, setPollOff] = useState<ReadonlySet<string>>(() => new Set());
  const [supplementOn, setSupplementOn] = useState<ReadonlySet<string>>(() => new Set());
  const [pollError, setPollError] = useState<{ key: string; text: string; detail?: string } | null>(null);
  const appPid = latest?.connected ? latest.app.pid : undefined;
  const pollable = canPoll(device);
  const watchSpec: WatchSpec | null =
    target && pollable
      ? target.kind === 'process'
        ? pollOff.has(tKey)
          ? null
          : { deviceId: target.deviceId, pid: target.pid }
        : supplementOn.has(tKey) && appPid !== undefined
          ? { deviceId: target.deviceId, pid: appPid }
          : null
      : null;
  const wKey = watchSpec ? watchKey(watchSpec) : '';
  useEffect(() => {
    if (!watchSpec || !target) return;
    const key = tKey;
    const isProcess = target.kind === 'process';
    setPollError(null);
    return acquireWatch(watchSpec, (err) => {
      const d = describeError(err);
      setPollError({ key, text: d.text, detail: d.detail });
      toast.error(t('perf.poll.failed'), { description: d.text });
      if (isProcess) setPollOff((s) => withKey(s, key));
      else setSupplementOn((s) => without(s, key));
    });
    // one watch per key; released when the target changes or the view unmounts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wKey]);
  const polling = wKey !== '';
  const pollingKeys = useMemo(() => new Set(target && polling && target.kind === 'process' ? [tKey] : []), [target, polling, tKey]);

  const startPolling = () => {
    if (!target) return;
    setPollError(null);
    if (target.kind === 'process') setPollOff((s) => without(s, tKey));
    else setSupplementOn((s) => withKey(s, tKey));
  };
  const stopPolling = () => {
    if (!target) return;
    if (target.kind === 'process') setPollOff((s) => withKey(s, tKey));
    else setSupplementOn((s) => without(s, tKey));
  };

  /* ───────────── Data ───────────── */
  const describeAnnotation = useCallback((e: LogEntry, _type: AnnotationType) => annotationText(e), []);
  const data = usePerfData({ target, sessions, apps, window: win, pausedAt, active, flutterLike, describeAnnotation });

  const togglePause = useCallback(() => setPausedAt((p) => (p === null ? Date.now() : null)), []);
  useShortcut('Space', togglePause, { enabled: active && target !== null });

  const label = target
    ? target.kind === 'app'
      ? latest?.app.name || target.bundleId
      : target.name || t('perf.target.unknownProcess', { pid: target.pid })
    : t('perf.target.none');
  const sub = target
    ? target.kind === 'app'
      ? [device?.name ?? t('perf.target.unknownDevice'), target.bundleId].join(' · ')
      : [`pid ${target.pid}`, device?.name ?? t('perf.target.unknownDevice')].join(' · ')
    : undefined;

  const exportCsv = () => {
    if (!target) return;
    const rows = perSecondRows(data.fieldSamples, [data.logBuckets, data.netBuckets], data.fromSec, data.toSec);
    const hasValues = rows.some((r) => r.logs || r.requests || r.cpu !== undefined || r.memoryMB !== undefined || r.fps !== undefined || r.heapMB !== undefined);
    if (!hasValues) {
      toast.info(t('perf.csvEmpty'));
      return;
    }
    downloadText(rowsToCsv(rows), csvFileName(`${label} ${device?.name ?? ''}`, Date.now()), 'text/csv;charset=utf-8');
    toast.success(t('perf.csvDone', { count: rows.length }));
  };

  const options = useMemo(
    () =>
      buildOptions({
        scopeDeviceIds:
          scope.kind === 'all'
            ? null
            : scope.kind === 'device' || scope.kind === 'deviceApp'
              ? [scope.deviceId]
              : apps[scope.appId]
                ? [apps[scope.appId]!.deviceId]
                : [],
        apps,
        devices,
        processes,
        labels: {
          sessions: (n) => t('perf.target.sessions', { count: n }),
          pid: (pid) => `pid ${pid}`,
          vm: t('perf.picker.vm'),
          sdk: t('perf.picker.sdk'),
        },
      }),
    [scope, apps, devices, processes, t],
  );

  const group = t('common.groups.perf');
  useCommands(
    active
      ? [
          { id: 'perf.pick', title: t('perf.cmd.pick'), group, icon: Gauge, keywords: ['target', 'hedef', 'process', 'süreç', 'app', 'uygulama'], run: () => setPickerOpen(true) },
          { id: 'perf.pause', title: t('perf.cmd.pause'), group, icon: pausedAt ? Play : Pause, shortcut: 'Space', keywords: ['pause', 'resume', 'duraklat', 'devam'], run: togglePause },
          { id: 'perf.csv', title: t('perf.cmd.csv'), group, icon: FileDown, keywords: ['csv', 'export', 'dışa aktar', 'excel'], run: exportCsv, disabled: !target },
          ...PERF_WINDOWS.map((w) => ({
            id: `perf.window.${w}`,
            title: t('perf.cmd.window', { window: t(`perf.window.${w}`) }),
            group,
            icon: Clock,
            keywords: ['window', 'range', 'aralık', 'pencere'],
            run: () => setWindow(w),
          })),
        ]
      : [],
  );

  /* ───────────── Formatting ───────────── */
  const fmt = useMemo(() => {
    const dec = (v: number, max = 1) => formatNumber(v, { maxFractionDigits: max });
    return {
      pct: (v: number) => formatPercent(v, { digits: v < 10 ? 1 : 0 }),
      pctNum: (v: number) => dec(v, v < 10 ? 1 : 0),
      mb: (v: number) => formatBytes(v * 1048576),
      mbParts: (v: number): [string, string] => {
        const s = formatBytes(v * 1048576);
        const i = s.lastIndexOf(' ');
        return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ''];
      },
      int: (v: number) => dec(v, 0),
      rate: (v: number) => dec(v, v < 10 ? 1 : 0),
      perSec: (v: number) => t('perf.tiles.perSec', { value: dec(v, v < 10 ? 1 : 0) }),
    };
    // lang: number formats follow the language
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, t]);

  // Chart inputs change only with the per-second data snapshot (stable identities → no needless redraws).
  const chartModel = useMemo(() => {
    const present = data.present;
    const { charts } = data;
    const pick = (list: readonly { spec: ChartSeriesSpec; ys: (number | null | undefined)[]; on: boolean }[]) => {
      const on = list.filter((x) => x.on);
      return { series: on.map((x) => x.spec), ys: on.map((x) => x.ys) };
    };
    return {
      xRange: [data.from / 1000, data.to / 1000] as [number, number],
      cpuChart: pick([{ spec: { key: 'cpu', label: t('perf.charts.series.cpu'), color: colors.cpu, kind: 'area', format: fmt.pct }, ys: charts.cpu.ys[0] ?? [], on: true }]),
      memChart: pick([
        { spec: { key: 'rss', label: t('perf.charts.series.rss'), color: colors.memory, kind: 'area', format: fmt.mb }, ys: charts.memory.ys[0] ?? [], on: present.has('memoryMB') },
        {
          spec: { key: 'heap', label: t('perf.charts.series.heap'), color: colors.heap, kind: present.has('memoryMB') ? 'line' : 'area', format: fmt.mb },
          ys: charts.memory.ys[1] ?? [],
          on: present.has('heapMB'),
        },
      ]),
      framesChart: pick([
        { spec: { key: 'fps', label: t('perf.charts.series.fps'), color: colors.fps, kind: 'line', format: fmt.int }, ys: charts.frames.ys[0] ?? [], on: present.has('fps') },
        { spec: { key: 'jank', label: t('perf.charts.series.jank'), color: colors.jank, kind: 'bars', format: fmt.rate }, ys: charts.frames.ys[1] ?? [], on: present.has('jankyFrames') },
      ]),
      series: {
        requests: [
          { key: 'req', label: t('perf.charts.series.requests'), color: colors.requests, kind: 'area', format: fmt.rate },
          { key: 'failed', label: t('perf.charts.series.failed'), color: colors.failed, kind: 'line', format: fmt.rate },
        ] satisfies ChartSeriesSpec[],
        logs: [
          { key: 'logs', label: t('perf.charts.series.logs'), color: colors.logs, kind: 'area', format: fmt.rate },
          { key: 'errors', label: t('perf.charts.series.errors'), color: colors.errorLogs, kind: 'line', format: fmt.rate },
        ] satisfies ChartSeriesSpec[],
      },
    };
  }, [data, colors, t, fmt]);

  const timeFormat = useCallback((sec: number, span: number) => formatClock(sec * 1000, span > 900 ? { seconds: false } : { ms: false }), []);
  const tooltipTime = useCallback((sec: number) => formatClock(sec * 1000, { ms: false }), []);

  /* ───────────── Rendering ───────────── */
  const toolbar = (
    <Toolbar aria-label={t('perf.title')}>
      <PickerButton
        buttonRef={pickerBtn}
        label={label}
        sub={sub}
        expanded={pickerOpen}
        onClick={() => {
          setPickerProcesses(false);
          setPickerOpen((o) => !o);
        }}
      />
      {target && pollable && (target.kind === 'process' || polling) ? (
        <span className="pf-poll">
          <StatusDot tone={polling ? 'success' : 'neutral'} pulse={polling} size={7} />
          <span className="pf-poll__text">{polling ? (target.kind === 'process' ? t('perf.poll.on') : t('perf.poll.supplementOn')) : t('perf.poll.off')}</span>
          <Button size="sm" variant="ghost" icon={polling ? CircleStop : Play} onClick={polling ? stopPolling : startPolling} title={t('perf.poll.stopsHint')}>
            {polling ? (target.kind === 'process' ? t('perf.poll.stop') : t('perf.poll.supplementOff')) : t('perf.poll.start')}
          </Button>
        </span>
      ) : null}
      <ToolbarSpacer />
      {pausedAt !== null ? <span className="pf-paused">{t('perf.paused', { time: formatClock(pausedAt, { ms: false }) })}</span> : null}
      <SegmentedControl<PerfWindow>
        size="sm"
        value={win}
        onChange={setWindow}
        aria-label={t('perf.window.label')}
        options={PERF_WINDOWS.map((w) => ({ value: w, label: t(`perf.window.${w}`) }))}
      />
      <ToolbarSeparator />
      <SegmentedControl<'charts' | 'table'>
        size="sm"
        value={view}
        onChange={setView}
        aria-label={t('perf.view.label')}
        options={[
          { value: 'charts', icon: ChartLine, tooltip: t('perf.view.charts') },
          { value: 'table', icon: Table2, tooltip: t('perf.view.table') },
        ]}
      />
      <IconButton icon={pausedAt !== null ? Play : Pause} label={pausedAt !== null ? t('perf.resume') : t('perf.pause')} shortcut="Space" active={pausedAt !== null} onClick={togglePause} disabled={!target} />
      <IconButton icon={FileDown} label={t('perf.csv')} onClick={exportCsv} disabled={!target} />
    </Toolbar>
  );

  const picker = (
    <TargetPicker
      open={pickerOpen}
      onOpenChange={setPickerOpen}
      anchorRef={pickerBtn}
      options={options}
      current={target}
      pollingKeys={pollingKeys}
      showDeviceNames={scope.kind === 'all'}
      onSelect={selectTarget}
      focusProcesses={pickerProcesses}
    />
  );

  if (!target) {
    const pickProcess = () => {
      setPickerProcesses(true);
      setPickerOpen(true);
    };
    return (
      <div className="pf fill col">
        {toolbar}
        <div className="pf-empty scroll-y fill">
          <ExplainEmpty
            capability="metrics"
            icon={Gauge}
            includePartial
            onAction={(a) => {
              if (a !== 'startProcessMetrics') return false;
              // Measure the scoped app's process here (polling starts with the pick).
              const item = scopeExplain.items[0];
              const main = item ? mainPidOf(item.group) : undefined;
              if (!item || !main) {
                pickProcess();
                return true;
              }
              selectTarget({ kind: 'process', deviceId: item.group.deviceId, pid: main.pid, name: main.name });
              return true;
            }}
            fallback={
          <EmptyState
            icon={Gauge}
            size="lg"
            tone="accent"
            title={t('perf.empty.noTarget.title')}
            description={t('perf.empty.noTarget.description')}
            actions={
              <>
                <Button
                  variant="primary"
                  icon={Cpu}
                  onClick={() => {
                    setPickerProcesses(true);
                    setPickerOpen(true);
                  }}
                >
                  {t('perf.empty.pickProcess')}
                </Button>
                <Button onClick={() => requestDeviceSection('vm')}>{t('perf.empty.attachVm')}</Button>
                <Button variant="ghost" onClick={() => ui.openSdkGuide()}>
                  {t('perf.empty.sdkGuide')}
                </Button>
              </>
            }
          />
            }
          />
        </div>
        {picker}
      </div>
    );
  }

  const { stats, charts } = data;
  const present = data.present;
  const metricsPresent = present.size > 0;
  const appConnected = sessions.some((s) => s.connected);
  const metricsCap = sessions.some(hasMetricsCapability);
  const canSupplement = target.kind === 'app' && pollable && appPid !== undefined && !polling;
  const fromProc = (f: MetricField) => (data.fromSupplement.has(f) ? t('perf.tiles.fromProcess') : undefined);
  const stale = (ts?: number) => ts !== undefined && data.to - ts > Math.max(10_000, data.intervalMs * 5);
  const staleSub = (ts?: number) => (stale(ts) && ts !== undefined ? t('perf.tiles.stale', { ago: formatRelative(ts) }) : undefined);
  const fpsSoftMax = (stats.fps.peak ?? 0) > 62 ? 120 : 60;

  const metricsEmpty = (): ReactNode => {
    if (target.kind === 'process') {
      const name = target.name ?? `pid ${target.pid}`;
      if (polling)
        return (
          <EmptyState size="sm" icon={Cpu} title={t('perf.empty.process.waiting')} description={t('perf.empty.process.waitingHint', { name })}>
            <Spinner size={16} />
          </EmptyState>
        );
      return (
        <EmptyState
          size="sm"
          icon={Cpu}
          title={t('perf.empty.process.offTitle', { name })}
          description={t('perf.empty.process.offDescription')}
          actions={
            pollable ? (
              <Button variant="primary" icon={Play} onClick={startPolling}>
                {t('perf.poll.start')}
              </Button>
            ) : undefined
          }
        />
      );
    }
    const app = latest?.app.name ?? target.bundleId;
    if (!metricsCap)
      return (
        <EmptyState
          size="sm"
          icon={Gauge}
          title={t('perf.empty.noMetrics.title', { app })}
          description={t('perf.empty.noMetrics.description')}
          actions={
            <>
              {canSupplement ? (
                <Button variant="primary" icon={Cpu} onClick={startPolling}>
                  {t('perf.poll.supplement')}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => ui.openSdkGuide()}>
                {t('perf.empty.sdkGuide')}
              </Button>
            </>
          }
        />
      );
    if (!appConnected) return <EmptyState size="sm" icon={Gauge} title={t('perf.empty.disconnected.title', { app })} description={t('perf.empty.disconnected.description')} />;
    return (
      <EmptyState size="sm" icon={Gauge} title={t('perf.empty.waiting.title')} description={t('perf.empty.waiting.description', { app })}>
        <Spinner size={16} />
      </EmptyState>
    );
  };

  const { xRange, cpuChart, memChart, framesChart, series } = chartModel;
  const annotations = data.annotations;
  const showCpu = present.has('cpu');
  const showMemory = present.has('memoryMB') || present.has('heapMB');
  const showFrames = present.has('fps') || present.has('jankyFrames');
  const showRequests = target.kind === 'app' || stats.requests.total > 0;
  const missing: string[] = [];
  if (metricsPresent) {
    if (!showCpu) missing.push(t('perf.charts.cpu'));
    if (!present.has('memoryMB')) missing.push(t('perf.charts.series.rss'));
    if (!present.has('heapMB') && target.kind === 'app') missing.push(t('perf.charts.series.heap'));
    if (!showFrames && target.kind === 'app') missing.push(t('perf.charts.series.fps'));
  }
  const firstChart = showCpu ? 'cpu' : showMemory ? 'memory' : showFrames ? 'frames' : showRequests ? 'requests' : 'logs';
  const rectProps = (name: string) => (name === firstChart ? { onPlotRect: (r: PlotRect) => setPlotRect((p) => (p && p.left === r.left && p.width === r.width ? p : r)) } : {});
  const common = { xRange, colors, annotations, timeFormat, tooltipTime, syncKey: SYNC_KEY, emptyText: t('perf.charts.noData') };
  const legendRate = (v: number) => fmt.rate(v);
  const avgNote = data.rateStep > 1 ? t('perf.charts.average', { step: data.rateStep }) : undefined;

  const cpuNow = stats.cpu.now;
  const memNow = stats.memory.now;
  const heapNow = stats.heap.now;
  const fpsNow = stats.fps.now;
  const errorsTotal = stats.errorLogs + stats.failedRequests;

  // Tiles that cannot apply to the target (e.g. FPS of a polled system process) are left out instead of
  // showing a row of "no data".
  const isApp = target.kind === 'app';
  const tileList: { key: string; node: ReactNode }[] = [
    {
      key: 'cpu',
      node: (
        <StatTile
          label={t('perf.tiles.cpu')}
          color={colors.cpu}
          value={cpuNow !== undefined ? fmt.pctNum(cpuNow) : undefined}
          unit="%"
          unitFirst={lang === 'tr'}
          placeholder={t('perf.tiles.noData')}
          sub={staleSub(stats.cpu.nowTs) ?? (stats.cpu.avg !== undefined ? t('perf.tiles.avg', { value: fmt.pct(stats.cpu.avg) }) : undefined)}
          hint={t('perf.tiles.cpuHint')}
          trend={stats.cpu.trend}
          stale={stale(stats.cpu.nowTs)}
          tag={fromProc('cpu')}
          action={
            cpuNow === undefined && canSupplement ? (
              <Button size="sm" variant="ghost" icon={Cpu} onClick={startPolling} title={appPid !== undefined ? t('perf.poll.supplementHint', { pid: appPid }) : undefined}>
                {t('perf.poll.supplement')}
              </Button>
            ) : undefined
          }
        />
      ),
    },
    {
      key: 'memory',
      node: (
        <StatTile
          label={t('perf.tiles.memory')}
          color={colors.memory}
          value={memNow !== undefined ? fmt.mbParts(memNow)[0] : undefined}
          unit={memNow !== undefined ? fmt.mbParts(memNow)[1] : undefined}
          placeholder={t('perf.tiles.noData')}
          sub={staleSub(stats.memory.nowTs) ?? (stats.memory.peak !== undefined ? t('perf.tiles.peak', { value: fmt.mb(stats.memory.peak) }) : undefined)}
          hint={t('perf.tiles.memoryHint')}
          trend={stats.memory.trend}
          stale={stale(stats.memory.nowTs)}
          tag={fromProc('memoryMB')}
        />
      ),
    },
    ...(isApp || present.has('heapMB')
      ? [
          {
            key: 'heap',
            node: (
              <StatTile
                label={t('perf.tiles.heap')}
                color={colors.heap}
                value={heapNow !== undefined ? fmt.mbParts(heapNow)[0] : undefined}
                unit={heapNow !== undefined ? fmt.mbParts(heapNow)[1] : undefined}
                placeholder={t('perf.tiles.noData')}
                sub={staleSub(stats.heap.nowTs) ?? (stats.heap.peak !== undefined ? t('perf.tiles.peak', { value: fmt.mb(stats.heap.peak) }) : undefined)}
                hint={t('perf.tiles.heapHint')}
                trend={stats.heap.trend}
                stale={stale(stats.heap.nowTs)}
              />
            ),
          },
        ]
      : []),
    ...(isApp || present.has('fps')
      ? [
          {
            key: 'fps',
            node: (
              <StatTile
                label={t('perf.tiles.fps')}
                color={colors.fps}
                value={fpsNow !== undefined ? fmt.int(fpsNow) : undefined}
                placeholder={stats.fps.idle ? t('perf.tiles.idle') : t('perf.tiles.noData')}
                sub={stats.fps.avg !== undefined ? t('perf.tiles.avg', { value: fmt.int(stats.fps.avg) }) : undefined}
                hint={flutterLike ? `${t('perf.tiles.fpsHint')} ${t('perf.tiles.idleHint')}` : t('perf.tiles.fpsHint')}
                trend={stats.fps.trend}
                stale={stale(stats.fps.nowTs) && !stats.fps.idle}
              />
            ),
          },
        ]
      : []),
    ...(isApp || present.has('jankyFrames')
      ? [
          {
            key: 'jank',
            node: (
              <StatTile
                label={t('perf.tiles.jank')}
                color={colors.jank}
                value={stats.jank.perSecNow !== undefined ? fmt.perSec(stats.jank.perSecNow) : undefined}
                placeholder={t('perf.tiles.noData')}
                sub={
                  stats.jank.count > 0
                    ? stats.jank.total === 0
                      ? t('perf.tiles.jankNone')
                      : stats.jank.percent !== undefined
                        ? t('perf.tiles.jankShare', { percent: formatPercent(stats.jank.percent, { digits: 1 }) })
                        : undefined
                    : undefined
                }
                hint={t('perf.tiles.jankHint')}
                trend={stats.jank.trend}
              />
            ),
          },
        ]
      : []),
    ...(showRequests
      ? [
          {
            key: 'requests',
            node: (
              <StatTile
                label={t('perf.tiles.requests')}
                color={colors.requests}
                value={fmt.rate(stats.requests.now)}
                sub={t('perf.tiles.avg', { value: fmt.rate(stats.requests.avg) })}
                hint={t('perf.tiles.requestsHint')}
                trend={stats.requests.trend}
              />
            ),
          },
        ]
      : []),
    {
      key: 'logs',
      node: (
        <StatTile
          label={t('perf.tiles.logs')}
          color={colors.logs}
          value={fmt.rate(stats.logs.now)}
          sub={t('perf.tiles.avg', { value: fmt.rate(stats.logs.avg) })}
          hint={t('perf.tiles.logsHint')}
          trend={stats.logs.trend}
        />
      ),
    },
    {
      key: 'errors',
      node: (
        <StatTile
          label={t('perf.tiles.errors')}
          color={colors.failed}
          value={fmt.int(errorsTotal)}
          sub={errorsTotal > 0 ? t('perf.tiles.errorsSplit', { logs: fmt.int(stats.errorLogs), requests: fmt.int(stats.failedRequests) }) : t('perf.tiles.inWindow')}
          hint={t('perf.tiles.errorsHint')}
          trend={stats.errorTrend}
          tone={errorsTotal > 0 ? 'danger' : 'default'}
        />
      ),
    },
  ];
  const n = tileList.length;
  const tileVars = { '--n-wide': n, '--n-mid': n <= 4 ? n : Math.ceil(n / 2), '--n-narrow': Math.min(2, n) } as CSSProperties;
  const tiles = (
    <div className="pf-tiles" role="list" aria-label={t('perf.tiles.label')} style={tileVars}>
      {tileList.map((tile) => (
        <div key={tile.key} role="listitem">
          {tile.node}
        </div>
      ))}
    </div>
  );

  const windowEmpty = data.hasSamples && !data.hasWindowSamples && win !== 'all';

  return (
    <div className="pf fill col">
      {toolbar}
      <div className="pf-body scroll-y fill">
        {pollError && pollError.key === tKey ? (
          <Callout tone="danger" compact title={t('perf.poll.failed')} className="pf-callout">
            {pollError.text}
            {pollError.detail ? <span className="pf-callout__detail mono">{pollError.detail}</span> : null}
          </Callout>
        ) : null}
        {tiles}
        {view === 'table' ? (
          <PerfTableView data={data} showRequests={showRequests} />
        ) : (
          <div className="pf-charts" aria-label={t('perf.charts.label')}>
            {windowEmpty ? (
              <Callout
                tone="info"
                compact
                className="pf-callout"
                title={t('perf.empty.window.title')}
                actions={
                  <Button size="sm" onClick={() => setWindow('all')}>
                    {t('perf.empty.window.showAll')}
                  </Button>
                }
              >
                {data.lastSampleTs !== undefined ? t('perf.empty.window.description', { ago: formatRelative(data.lastSampleTs) }) : null}
              </Callout>
            ) : null}
            <EventLane annotations={annotations} from={data.from} to={data.to} rect={plotRect} />
            {!metricsPresent ? <div className="pf-chart pf-chart--empty">{metricsEmpty()}</div> : null}
            {showCpu ? (
              <TimeChart
                {...common}
                {...rectProps('cpu')}
                title={t('perf.charts.cpu')}
                series={cpuChart.series}
                xs={charts.cpu.xs}
                ys={cpuChart.ys}
                softMax={10}
                yFormat={(v) => fmt.pct(v)}
                legendValues={[cpuNow !== undefined ? fmt.pct(cpuNow) : undefined]}
                note={fromProc('cpu')}
                ariaLabel={`${t('perf.charts.cpu')}: ${cpuNow !== undefined ? fmt.pct(cpuNow) : '—'}`}
              />
            ) : null}
            {showMemory ? (
              <TimeChart
                {...common}
                {...rectProps('memory')}
                title={t('perf.charts.memory')}
                series={memChart.series}
                xs={charts.memory.xs}
                ys={memChart.ys}
                softMax={16}
                yFormat={(v) => (v === 0 ? '0' : fmt.mb(v))}
                legendValues={[
                  ...(present.has('memoryMB') ? [memNow !== undefined ? fmt.mb(memNow) : undefined] : []),
                  ...(present.has('heapMB') ? [heapNow !== undefined ? fmt.mb(heapNow) : undefined] : []),
                ]}
                note={fromProc('memoryMB')}
                ariaLabel={`${t('perf.charts.memory')}: ${memNow !== undefined ? fmt.mb(memNow) : '—'}`}
              />
            ) : null}
            {showFrames ? (
              <TimeChart
                {...common}
                {...rectProps('frames')}
                title={t('perf.charts.frames')}
                series={framesChart.series}
                xs={charts.frames.xs}
                ys={framesChart.ys}
                softMax={fpsSoftMax}
                snapMax
                yFormat={(v) => fmt.int(v)}
                legendValues={[
                  ...(present.has('fps') ? [fpsNow !== undefined ? fmt.int(fpsNow) : stats.fps.idle ? t('perf.tiles.idle') : undefined] : []),
                  ...(present.has('jankyFrames') ? [stats.jank.perSecNow !== undefined ? fmt.rate(stats.jank.perSecNow) : undefined] : []),
                ]}
                ariaLabel={`${t('perf.charts.frames')}: ${fpsNow !== undefined ? fmt.int(fpsNow) : '—'}`}
              />
            ) : null}
            {showRequests ? (
              <TimeChart
                {...common}
                {...rectProps('requests')}
                title={t('perf.charts.requests')}
                note={avgNote}
                series={series.requests}
                xs={charts.requests.xs}
                ys={charts.requests.ys}
                softMax={1}
                yFormat={legendRate}
                legendValues={[fmt.rate(stats.requests.now), fmt.rate(stats.failedRate.now)]}
                ariaLabel={`${t('perf.charts.requests')}: ${fmt.rate(stats.requests.now)}`}
              />
            ) : null}
            <TimeChart
              {...common}
              {...rectProps('logs')}
              title={t('perf.charts.logs')}
              note={avgNote}
              series={series.logs}
              xs={charts.logs.xs}
              ys={charts.logs.ys}
              softMax={1}
              yFormat={legendRate}
              legendValues={[fmt.rate(stats.logs.now), fmt.rate(stats.errorRate.now)]}
              ariaLabel={`${t('perf.charts.logs')}: ${fmt.rate(stats.logs.now)}`}
            />
            {missing.length > 0 ? <p className="pf-missing">{t('perf.charts.missing', { fields: missing.join(', ') })}</p> : null}
          </div>
        )}
      </div>
      {picker}
    </div>
  );
}

function PerfTableView({ data, showRequests }: { data: ReturnType<typeof usePerfData>; showRequests: boolean }) {
  const rows = useMemo(
    () => perSecondRows(data.fieldSamples, [data.logBuckets, data.netBuckets], data.fromSec, data.toSec).reverse(),
    [data],
  );
  return <PerfTable rows={rows} showRequests={showRequests} />;
}
