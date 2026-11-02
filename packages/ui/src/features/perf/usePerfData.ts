/**
 * Everything the Performance view draws, derived from the stores at most once per second:
 * metric samples of the target (app sessions + optional process polling), per-second log/network rates,
 * annotations, stats for the tiles and chart series for the visible window.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSession, LogEntry, MetricSample, NetworkEntry } from '@durbun/protocol';
import {
  compileScope,
  isNetworkError,
  logStore,
  metricsStore,
  networkStore,
  useLogVersion,
  useMetricsVersion,
  useNetworkVersion,
  type MetricSeries,
} from '../../data';
import { systemLineText } from '../../i18n';
import {
  METRIC_FIELDS,
  RateBuckets,
  chooseFieldSource,
  fieldStats,
  fieldValue,
  gapThresholdMs,
  jankPerSecond,
  jankStats,
  joinPoints,
  mergeSamples,
  rateSeries,
  rateStats,
  rateStepSec,
  sliceByTime,
  targetKey,
  toPoints,
  typicalIntervalMs,
  windowRange,
  type FieldStats,
  type JankStats,
  type MetricField,
  type PerfTarget,
  type PerfWindow,
  type RateStats,
} from './model';
import { LogTraffic, networkTraffic, type Annotation, type AnnotationType } from './traffic';

export interface ChartData {
  xs: number[];
  ys: (number | null | undefined)[][];
}

export interface PerfData {
  from: number;
  to: number;
  /** Complete seconds covered by the rate charts. */
  fromSec: number;
  toSec: number;
  rateStep: number;
  intervalMs: number;
  /** The target's samples (whole history) exist at all. */
  hasSamples: boolean;
  /** Samples inside the window. */
  hasWindowSamples: boolean;
  lastSampleTs?: number;
  /** Fields that appear anywhere in the target's history (primary or supplement). */
  present: ReadonlySet<MetricField>;
  /** Fields whose window values come from the polled process instead of the app. */
  fromSupplement: ReadonlySet<MetricField>;
  /** Window samples per field (CSV / table). */
  fieldSamples: Partial<Record<MetricField, readonly MetricSample[]>>;
  charts: { cpu: ChartData; memory: ChartData; frames: ChartData; requests: ChartData; logs: ChartData };
  stats: {
    cpu: FieldStats;
    memory: FieldStats;
    heap: FieldStats;
    fps: FieldStats;
    jank: JankStats;
    requests: RateStats;
    logs: RateStats;
    failedRate: RateStats;
    errorRate: RateStats;
    errorLogs: number;
    failedRequests: number;
    errorTrend: number[];
  };
  annotations: Annotation[];
  logBuckets: RateBuckets;
  netBuckets: RateBuckets;
}

/** Re-render every `ms` while enabled (moving time window). */
export function useTicker(ms: number, enabled: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
  return tick;
}

function seriesSamples(list: readonly MetricSeries[]): readonly MetricSample[] {
  return mergeSamples(list.map((s) => s.samples));
}

const EMPTY: readonly MetricSample[] = [];

export function usePerfData(opts: {
  target: PerfTarget | null;
  sessions: readonly AppSession[];
  apps: Record<string, AppSession>;
  window: PerfWindow;
  /** Pause time (frozen view) or null when live. */
  pausedAt: number | null;
  active: boolean;
  flutterLike: boolean;
  describeAnnotation: (e: LogEntry, type: AnnotationType) => string;
}): PerfData {
  const { target, sessions, apps, window: win, pausedAt, active, flutterLike } = opts;
  const live = active && pausedAt === null;
  const mv = useMetricsVersion({ throttleMs: 1000, enabled: live });
  const lv = useLogVersion({ throttleMs: 1000, enabled: live });
  const nv = useNetworkVersion({ throttleMs: 1000, enabled: live });
  const tick = useTicker(1000, live);

  const tKey = targetKey(target);
  const sessionIds = sessions.map((s) => s.id).join(',');
  const pids = useMemo(() => {
    const set = new Set<number>();
    for (const s of sessions) if (typeof s.app.pid === 'number') set.add(s.app.pid);
    return set;
  }, [sessions]);
  const pidKey = [...pids].sort((a, b) => a - b).join(',');

  // Samples (whole history) — recomputed when metrics arrive.
  const samples = useMemo(() => {
    if (!target) return { primary: EMPTY, supplement: EMPTY };
    const all = [...metricsStore.series.values()];
    if (target.kind === 'process') {
      return { primary: seriesSamples(all.filter((s) => s.deviceId === target.deviceId && s.appId === undefined && s.pid === target.pid)), supplement: EMPTY };
    }
    const ids = new Set(sessionIds ? sessionIds.split(',') : []);
    const primary = seriesSamples(all.filter((s) => s.appId !== undefined && ids.has(s.appId)));
    const supplement = seriesSamples(all.filter((s) => s.appId === undefined && s.deviceId === target.deviceId && s.pid !== undefined && pids.has(s.pid)));
    return { primary, supplement };
    // mv: metricsStore mutates in place; the version is the change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mv, tKey, sessionIds, pidKey]);

  const present = useMemo(() => {
    const set = new Set<MetricField>();
    for (const list of [samples.primary, samples.supplement]) {
      for (const s of list) {
        for (const f of METRIC_FIELDS) if (!set.has(f) && fieldValue(s, f) !== undefined) set.add(f);
        if (set.size === METRIC_FIELDS.length) break;
      }
    }
    return set;
  }, [samples]);

  // Log traffic (incremental).
  const trafficRef = useRef<LogTraffic | null>(null);
  trafficRef.current ??= new LogTraffic();
  const describeRef = useRef(opts.describeAnnotation);
  describeRef.current = opts.describeAnnotation;
  const trafficKey = target ? `${tKey}|${sessionIds}|${pidKey}` : '';
  const logPredicate = useMemo(() => {
    if (!target) return () => false;
    if (target.kind === 'app') {
      const compiled = compileScope({ kind: 'app', appId: target.appId }, { apps });
      return (e: LogEntry) => compiled.logs(e);
    }
    const { deviceId, pid } = target;
    return (e: LogEntry) => (e.kind === 'marker' ? e.deviceId === deviceId || e.deviceId === '' : e.deviceId === deviceId && e.pid === pid);
    // apps only matter through the session ids/pids captured in trafficKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trafficKey]);
  const trafficRev = useMemo(() => {
    const tr = trafficRef.current!;
    tr.update(logStore, trafficKey, logPredicate, (e, type) => describeRef.current(e, type));
    return tr.revision;
    // lv: logStore mutates in place; the version is the change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lv, trafficKey, logPredicate]);

  // Network traffic (re-bucketed; entries change state after they were first seen).
  const netPredicate = useMemo(() => {
    if (!target) return () => false;
    if (target.kind === 'app') {
      const ids = new Set(sessionIds ? sessionIds.split(',') : []);
      return (e: NetworkEntry) => e.appId !== undefined && ids.has(e.appId);
    }
    const ids = new Set(Object.values(apps).filter((a) => a.deviceId === target.deviceId && a.app.pid === target.pid).map((a) => a.id));
    return (e: NetworkEntry) => e.appId !== undefined && ids.has(e.appId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trafficKey]);
  const netBuckets = useMemo(
    () => networkTraffic(networkStore.list(), netPredicate, isNetworkError),
    // nv: networkStore mutates in place; the version is the change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nv, netPredicate],
  );

  return useMemo<PerfData>(() => {
    const now = pausedAt ?? Date.now();
    const { primary, supplement } = samples;
    const traffic = trafficRef.current!;
    const lastSampleTs = Math.max(primary[primary.length - 1]?.ts ?? -Infinity, supplement[supplement.length - 1]?.ts ?? -Infinity);
    const firstSampleTs = Math.min(primary[0]?.ts ?? Infinity, supplement[0]?.ts ?? Infinity);
    const earliestRate = Math.min(traffic.buckets.earliestSec() ?? Infinity, netBuckets.earliestSec() ?? Infinity) * 1000;
    // "All" spans the metric history when there is one (log history can reach much further back).
    const oldest = Number.isFinite(firstSampleTs) ? firstSampleTs : earliestRate;
    const { from, to } = windowRange(win, now, Number.isFinite(lastSampleTs) ? lastSampleTs : undefined, Number.isFinite(oldest) ? oldest : undefined);
    const intervalMs = typicalIntervalMs(primary.length >= supplement.length ? primary : supplement);
    const gapMs = gapThresholdMs(intervalMs);

    // Window slices (one extra second on the left keeps the first jank Δt meaningful).
    const pWin = sliceByTime(primary, from - intervalMs, to);
    const sWin = sliceByTime(supplement, from - intervalMs, to);
    const source = (field: MetricField) => chooseFieldSource(pWin, sWin, field);
    const fromSupplement = new Set<MetricField>();
    const fieldSamples: Partial<Record<MetricField, readonly MetricSample[]>> = {};
    for (const f of METRIC_FIELDS) {
      const src = source(f);
      if (src.source === 'supplement') fromSupplement.add(f);
      if (src.source !== 'none') fieldSamples[f] = src.samples;
    }
    const inWindow = (list: readonly MetricSample[]) => sliceByTime(list, from, to);
    const cpuSrc = fieldSamples.cpu ?? EMPTY;
    const memSrc = fieldSamples.memoryMB ?? EMPTY;
    const heapSrc = fieldSamples.heapMB ?? EMPTY;
    const fpsSrc = fieldSamples.fps ?? fieldSamples.jankyFrames ?? EMPTY;

    const cpuPts = toPoints(cpuSrc, 'cpu', { gapMs });
    const memJoin = joinPoints([toPoints(memSrc, 'memoryMB', { gapMs }), toPoints(heapSrc, 'heapMB', { gapMs })]);
    const framesJoin = joinPoints([
      toPoints(fpsSrc, 'fps', { gapMs, zeroIsIdle: flutterLike }),
      toPoints(fieldSamples.jankyFrames ?? EMPTY, 'jankyFrames', { gapMs, value: (s, prev) => jankPerSecond(s, prev, intervalMs) }),
    ]);

    // Rates: complete seconds only (the current second is still filling up).
    const fromSec = Math.ceil(from / 1000);
    const toSec = Math.floor(Math.min(to, pausedAt ?? Date.now()) / 1000) - 1;
    const rateStep = rateStepSec(to - from);
    const req = rateSeries(netBuckets, fromSec, toSec, rateStep, ['requests', 'failedRequests']);
    const logs = rateSeries(traffic.buckets, fromSec, toSec, rateStep, ['logs', 'errorLogs']);

    const errorLogs = traffic.buckets.sum(fromSec, toSec, 'errorLogs');
    const failedRequests = netBuckets.sum(fromSec, toSec, 'failedRequests');
    const errSeries = traffic.buckets.series(fromSec, toSec, 'errorLogs');
    const failSeries = netBuckets.series(fromSec, toSec, 'failedRequests');
    const errorTrend = errSeries.map((v, i) => v + (failSeries[i] ?? 0));
    const trendStep = Math.max(1, Math.ceil(errorTrend.length / 48));
    const compactErrors: number[] = [];
    for (let i = 0; i < errorTrend.length; i += trendStep) compactErrors.push(errorTrend.slice(i, i + trendStep).reduce((a, b) => a + b, 0));

    const annotations = traffic.annotations.filter((a) => a.ts >= from && a.ts <= to);
    const hasWindowSamples = inWindow(pWin).length > 0 || inWindow(sWin).length > 0;

    return {
      from,
      to,
      fromSec,
      toSec,
      rateStep,
      intervalMs,
      hasSamples: primary.length > 0 || supplement.length > 0,
      hasWindowSamples,
      lastSampleTs: Number.isFinite(lastSampleTs) ? lastSampleTs : undefined,
      present,
      fromSupplement,
      fieldSamples,
      charts: {
        cpu: { xs: cpuPts.xs, ys: [cpuPts.ys] },
        memory: memJoin,
        frames: framesJoin,
        requests: { xs: req.xs, ys: req.ys },
        logs: { xs: logs.xs, ys: logs.ys },
      },
      stats: {
        cpu: fieldStats(inWindow(cpuSrc), 'cpu'),
        memory: fieldStats(inWindow(memSrc), 'memoryMB'),
        heap: fieldStats(inWindow(heapSrc), 'heapMB'),
        fps: fieldStats(inWindow(fpsSrc), 'fps', { zeroIsIdle: flutterLike }),
        jank: jankStats(inWindow(fieldSamples.jankyFrames ?? EMPTY), intervalMs),
        requests: rateStats(netBuckets, fromSec, toSec, 'requests'),
        logs: rateStats(traffic.buckets, fromSec, toSec, 'logs'),
        failedRate: rateStats(netBuckets, fromSec, toSec, 'failedRequests'),
        errorRate: rateStats(traffic.buckets, fromSec, toSec, 'errorLogs'),
        errorLogs,
        failedRequests,
        errorTrend: compactErrors,
      },
      annotations,
      logBuckets: traffic.buckets,
      netBuckets,
    };
    // tick: the window slides every second while live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, present, trafficRev, netBuckets, win, pausedAt, tick, flutterLike]);
}

/** Label of an annotated log entry (system lines localized, crashes → their headline). */
export function annotationText(e: LogEntry): string {
  if (e.source === 'system') return systemLineText(e);
  const headline = e.error?.message || e.message.split('\n', 1)[0] || '';
  return headline.length > 140 ? `${headline.slice(0, 139)}…` : headline;
}
