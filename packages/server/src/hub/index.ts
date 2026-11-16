/**
 * Hub: the in-memory store behind Dürbün (SPEC §5.2). Logs live in a ring bounded by rows and bytes, each
 * row capped when stored (hub/logSize.ts; crash / ANR rows it evicts are kept apart, see MAX_KEPT_CRASH_LOGS),
 * network entries and bodies in a budgeted store, metrics in per-series rings. Every change is batched
 * (~100 ms) for the UI.
 *
 * Implemented with closures (no `this`) so callers may pass methods around unbound.
 */
import type {
  AppSession,
  ClearTarget,
  DeviceApp,
  DeviceInfo,
  LogEntry,
  LogLevel,
  LogOrigin,
  MetricSample,
  NetworkDetail,
  NetworkEntry,
  ProcessUpdate,
  ServerSettings,
  SessionExport,
  StoreEvictions,
  StoreLimits,
  UiNotice,
} from '@durbun/protocol';
import { randomBytes } from 'node:crypto';
import { levelRank, networkLogLevel } from '@durbun/protocol';
import type { ClearEvent, CreateHubOptions, DeviceLogInput, Hub, HubChange, SystemLogInput } from '../types';
import { SERVER_VERSION } from '../version';
import { appScope } from './appScope';
import { ChangeBatcher } from './batcher';
import { copyDeviceApp, crashRecordCounter, deviceAppKey, DeviceAppStore } from './deviceApps';
import {
  appConnectedLine,
  appDisconnectedLine,
  appReconnectedLine,
  deviceConnectedLine,
  deviceDisconnectedLine,
  markerLine,
  processLine,
} from './lifecycle';
import { ConsoleEchoFilter } from './consoleEcho';
import { EvictionCounter } from './evictions';
import { MockHitCounter } from './mockHits';
import { capLogEntry, logEntryBytes } from './logSize';
import { MetricsStore, sanitizeSample, type MetricSeriesInfo } from './metrics';
import { cleanUndefined, DISCONNECTED_ERROR, NetworkStore, type NetworkLimits } from './network';
import { RingBuffer } from './ringBuffer';
import {
  finite,
  isRecord,
  mergeReaders,
  normKind,
  normLevel,
  normOrigin,
  normSdkLayers,
  sanitizeImportedApp,
  sanitizeImportedDevice,
  sanitizeImportedLog,
  sanitizeImportedNetwork,
  sessionVersionProblem,
  toMessage,
} from './sanitize';

export const HUB_BATCH_INTERVAL_MS = 100;
export const HUB_MAX_QUEUED_LOGS = 2000;
/**
 * Crash / ANR rows pushed out of the log ring by newer lines (a busy iPhone streams ~1000 daemon lines/s)
 * are kept apart, the newest this many: a crash from an hour ago must not vanish while its app's crash
 * count still says it happened.
 */
export const MAX_KEPT_CRASH_LOGS = 5_000;
/**
 * Byte budget of the kept crashes next to their count: a crash row may hold 256 K characters each of
 * message, stack and data, so 5 000 of them could reach gigabytes. The oldest go first; the newest stays.
 */
export const MAX_KEPT_CRASH_BYTES = 64 * 1024 * 1024;
/**
 * Byte budget of the log ring (estimated JSON size, hub/logSize.ts) next to its row count: rows are capped
 * at 256 K characters, but 200 000 of them would still not fit in memory. The oldest rows go first while
 * the ring is over budget (crash / ANR rows move to the kept crashes as with the row count).
 */
export const MAX_LOG_STORE_BYTES = 256 * 1024 * 1024;
/** Rows that survive ring eviction: crashes and ANRs, live or read from the device (dropbox, .ips). */
export const isKeptCrashLog = (e: Pick<LogEntry, 'kind' | 'origin'>): boolean =>
  e.kind === 'crash' || e.kind === 'anr' || e.origin === 'dropbox' || e.origin === 'crash-report';
/** Virtual device that owns requests replayed from the desktop. */
export const DESKTOP_DEVICE_ID = 'desktop';
/** Imported data lives on these virtual devices. */
export const IMPORT_DEVICE_PREFIX = 'import:';
/** Name prefix of imported devices. */
export const IMPORT_NAME_PREFIX = '📁 ';

const ERROR_RANK = levelRank('error');
/** Request rows whose level may still follow their outcome (oldest dropped first: a request that never ends). */
const MAX_OPEN_NET_ROWS = 10_000;
const MAX_PROCESSES_PER_DEVICE = 4096;

const pidKey = (deviceId: string, pid: number) => `${deviceId}\u0000${pid}`;
/** Where lines of an app session come from (SPEC §10.2): the VM service, an imported file, else the SDK. */
const appOrigin = (app: AppSession): LogOrigin =>
  app.transport === 'vm-service' ? 'vm-service' : app.transport === 'import' ? 'import' : 'sdk';

const sessionIndexKey = (deviceId: string, sessionKey: string) => `${deviceId}\u0000${sessionKey}`;
/** AppSession.sdk with its own copy of the known layers (SPEC §10.6; unknown values dropped). */
function copySdk(sdk: AppSession['sdk']): AppSession['sdk'] {
  const { layers: raw, ...rest } = sdk;
  const layers = normSdkLayers(raw);
  return layers ? { ...rest, layers } : rest;
}
const copyApp = (app: AppSession): AppSession => ({ ...app, stats: { ...app.stats } });
const limitsFrom = (s: ServerSettings): NetworkLimits => ({
  maxEntries: s.maxNetworkEntries,
  maxBodyBytes: Math.max(0, s.maxBodyStoreMB) * 1024 * 1024,
});

export function createHub(opts: CreateHubOptions): Hub {
  const logger = opts.logger;
  let settings: ServerSettings = { ...opts.settings };
  let watched = new Set<string>(settings.watchedApps ?? []);

  let nextLogId = 1;
  let nextAppSeq = 1;
  let nextImportSeq = 1;
  let nextReplaySeq = 1;
  let markerSeq = 0;
  let disposed = false;

  const logs = new RingBuffer<LogEntry>(settings.maxLogEntries);
  const maxLogBytes = opts.maxLogBytes !== undefined && opts.maxLogBytes > 0 ? opts.maxLogBytes : MAX_LOG_STORE_BYTES;
  /** Estimated size of every row in `logs` (logEntryBytes, taken when stored) and their sum. */
  const logSizes = new WeakMap<LogEntry, number>();
  let logBytes = 0;
  /** Crash / ANR rows evicted from `logs`, in id order; every one is older than the oldest row in `logs`. */
  const keptCrashes = new RingBuffer<LogEntry>(MAX_KEPT_CRASH_LOGS);
  const maxKeptBytes = opts.maxKeptCrashBytes !== undefined && opts.maxKeptCrashBytes > 0 ? opts.maxKeptCrashBytes : MAX_KEPT_CRASH_BYTES;
  let keptBytes = 0;
  /**
   * The log row of each request whose outcome may still change (net id → row, insertion order, at most
   * MAX_OPEN_NET_ROWS): its level follows the outcome (networkLogLevel) when the response or error arrives.
   * The row is changed in place: it keeps its id and position, history and exports carry the new level.
   */
  const openNetRows = new Map<string, LogEntry>();
  const devices = new Map<string, DeviceInfo>();
  const apps = new Map<string, AppSession>();
  /** deviceId + sessionKey → app id (session reuse on reconnect). */
  const sessionIndex = new Map<string, string>();
  /** deviceId + pid → app id (device log attribution). */
  const appByPid = new Map<string, string>();
  /** Latest device timestamp seen per app (end time for requests failed by a disconnect). */
  const appLastTs = new Map<string, number>();
  /** deviceId → pid → latest process info. */
  const processes = new Map<string, Map<number, ProcessUpdate>>();
  /** deviceId → app ids and process names of every SDK app ever seen there. */
  const seenAppNames = new Map<string, Set<string>>();

  /** Data generation for UI resume: new per hub, the suffix counts clears. */
  const bootId = randomBytes(6).toString('hex');
  let clearSeq = 0;
  const epoch = () => `${bootId}.${clearSeq}`;
  const evictions = new EvictionCounter();
  const oldestLogId = () => logs.first()?.id ?? 0;
  const evictionSnapshot = (): StoreEvictions => evictions.snapshot(oldestLogId());

  const mockHits = new MockHitCounter();
  const batcher = new ChangeBatcher(HUB_BATCH_INTERVAL_MS, HUB_MAX_QUEUED_LOGS, logger, () => {
    const extras: Partial<HubChange> = { netSeq: network.seq };
    if (evictions.takeIfChanged()) extras.evictions = evictionSnapshot();
    if (mockHits.takeIfChanged()) extras.mockHits = mockHits.snapshot();
    return extras;
  });
  const network = new NetworkStore(
    limitsFrom(settings),
    (entry) => batcher.networkChanged(entry),
    (eviction) => {
      if (eviction.kind === 'entry') evictions.request(eviction.entry);
      else evictions.body();
    },
    (entry) => mockHits.hit(entry.mockRuleId!, entry.appId, entry.endTs ?? entry.startTs),
  );
  const metrics = new MetricsStore({ keep: () => keepMetricSeries() });
  const deviceApps = new DeviceAppStore({
    onChange: (app) => batcher.deviceAppChanged(app),
    onRemove: (key) => batcher.deviceAppRemoved(key),
  });

  const clearedListeners = new Set<(event: ClearEvent) => void>();
  const noticeListeners = new Set<(notice: UiNotice) => void>();
  const logTaps = new Set<(entries: LogEntry[]) => void>();

  /* ───────────── helpers ───────────── */

  function callAll<T>(listeners: Set<(value: T) => void>, value: T, what: string): void {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (err) {
        logger.warn(`${what} listener failed`, err);
      }
    }
  }

  /** A row left the ring: a crash / ANR row moves to the kept crashes, any other row is counted as deleted. */
  function keepIfCrash(evicted: LogEntry | undefined, byBytes = false): void {
    if (!evicted) return;
    if (!isKeptCrashLog(evicted)) {
      evictions.log(evicted, byBytes);
      return;
    }
    keptBytes += sizeOf(evicted);
    const dropped = keptCrashes.push(evicted);
    if (dropped) {
      keptBytes -= sizeOf(dropped);
      evictions.log(dropped, false);
    }
    while (keptBytes > maxKeptBytes && keptCrashes.size > 1) {
      const gone = keptCrashes.shift()!;
      keptBytes -= sizeOf(gone);
      evictions.log(gone, true);
    }
  }

  const sizeOf = (e: LogEntry): number => logSizes.get(e) ?? logEntryBytes(e);

  /** Recount `logBytes` / `keptBytes` after rows left other than by push/shift (clear, retain, new capacity). */
  function recountLogBytes(): void {
    logBytes = 0;
    logs.forEach((e) => (logBytes += sizeOf(e)));
    keptBytes = 0;
    keptCrashes.forEach((e) => (keptBytes += sizeOf(e)));
  }

  /**
   * Metric series the store must spare (hub/metrics.ts): those of a connected session and of the newest
   * session of each app on each device. The Performance view shows an app across its sessions, so after hot
   * restarts the older sessions' series may go; a pid series (device polling) lives only while sampled.
   */
  function keepMetricSeries(): (series: MetricSeriesInfo) => boolean {
    const newest = new Map<string, AppSession>();
    for (const app of apps.values()) {
      const key = `${app.deviceId}\u0000${app.app.id}`;
      const prev = newest.get(key);
      if (!prev || app.connectedAt >= prev.connectedAt) newest.set(key, app);
    }
    const kept = new Set<string>();
    for (const app of newest.values()) kept.add(app.id);
    for (const app of apps.values()) if (app.connected) kept.add(app.id);
    return (series) => series.appId !== undefined && kept.has(series.appId);
  }

  /** Every stored row in id order: kept crashes (older than the ring) first, then the ring. */
  function allLogs(): LogEntry[] {
    return keptCrashes.size === 0 ? logs.toArray() : keptCrashes.toArray().concat(logs.toArray());
  }

  function trackNetRow(netId: string, row: LogEntry): void {
    openNetRows.delete(netId);
    openNetRows.set(netId, row);
    if (openNetRows.size > MAX_OPEN_NET_ROWS) openNetRows.delete(openNetRows.keys().next().value!);
  }

  /** The request's outcome arrived: its row takes the outcome's level; a completed request's row is final. */
  function settleNetRow(entry: NetworkEntry): void {
    const row = openNetRows.get(entry.id);
    if (!row) return;
    row.level = networkLogLevel(entry);
    if (entry.state === 'complete') openNetRows.delete(entry.id);
  }

  function appendLogs(entries: LogEntry[], tap = true): void {
    if (entries.length === 0 || disposed) return;
    for (const e of entries) {
      capLogEntry(e);
      const size = logEntryBytes(e);
      logSizes.set(e, size);
      logBytes += size;
      const evicted = logs.push(e);
      if (evicted) {
        logBytes -= sizeOf(evicted);
        keepIfCrash(evicted);
      }
    }
    while (logBytes > maxLogBytes && logs.size > 1) {
      const evicted = logs.shift()!;
      logBytes -= sizeOf(evicted);
      keepIfCrash(evicted, true);
    }
    batcher.addLogs(entries);
    if (tap && logTaps.size > 0) callAll(logTaps, entries, 'onLogs');
  }

  function attachAppProcess(entry: LogEntry, app: AppSession): void {
    if (app.app.pid !== undefined) entry.pid = app.app.pid;
    entry.process = app.app.processName || app.app.id;
  }

  function systemEntry(deviceId: string, input: SystemLogInput): LogEntry {
    const entry: LogEntry = {
      id: nextLogId++,
      ts: Date.now(),
      deviceId,
      source: 'system',
      origin: 'durbun',
      level: normLevel(input.level ?? 'info'),
      tag: 'durbun',
      message: toMessage(input.message),
      kind: normKind(input.kind) ?? 'lifecycle',
    };
    if (input.appId) {
      entry.appId = input.appId;
      const app = apps.get(input.appId);
      if (app) attachAppProcess(entry, app);
    }
    if (input.code) entry.code = input.code;
    if (input.params) entry.params = input.params;
    if (input.data !== undefined) entry.data = input.data;
    return entry;
  }

  function pushSystem(deviceId: string, input: SystemLogInput): LogEntry {
    const entry = systemEntry(deviceId, input);
    appendLogs([entry]);
    return entry;
  }

  function deviceName(deviceId: string): string {
    return devices.get(deviceId)?.name ?? deviceId;
  }

  function isQuietDevice(id: string): boolean {
    return id === DESKTOP_DEVICE_ID || id.startsWith(IMPORT_DEVICE_PREFIX);
  }

  function emitDeviceTransition(prev: DeviceInfo | undefined, next: DeviceInfo, detail?: string): void {
    if (isQuietDevice(next.id)) return;
    const wasOnline = prev?.state === 'online';
    const isOnline = next.state === 'online';
    if (isOnline && !wasOnline) pushSystem(next.id, deviceConnectedLine(next));
    else if (wasOnline && !isOnline) pushSystem(next.id, deviceDisconnectedLine(next, detail ?? next.stateDetail));
  }

  function storeDevice(prev: DeviceInfo | undefined, next: DeviceInfo, detail?: string): void {
    cleanUndefined(next);
    devices.set(next.id, next);
    batcher.deviceChanged(next);
    emitDeviceTransition(prev, next, detail);
    // Nothing on a device that went offline / unplugged can be confirmed running; its apps stay listed
    // (device facts). A device that is gone (disconnected) starts from scratch when it comes back; one that
    // was only offline / unauthorized gets the last reported pids back unless its driver reported meanwhile
    // (drivers whose session survives, e.g. iOS re-trust, only report pid changes).
    if (next.state === 'disconnected') {
      if (prev?.state !== 'disconnected') deviceApps.markDeviceStopped(next.id);
    } else if (prev?.state === 'online' && next.state !== 'online') deviceApps.markDeviceStopped(next.id, true);
    else if (prev && prev.state !== 'online' && next.state === 'online') deviceApps.resumeDevice(next.id);
  }

  function rememberAppNames(app: AppSession): void {
    let names = seenAppNames.get(app.deviceId);
    if (!names) {
      names = new Set();
      seenAppNames.set(app.deviceId, names);
    }
    if (app.app.id) names.add(app.app.id);
    if (app.app.processName) names.add(app.app.processName);
  }

  function indexPid(app: AppSession): void {
    if (app.app.pid !== undefined) appByPid.set(pidKey(app.deviceId, app.app.pid), app.id);
  }

  function unindexPid(app: AppSession): void {
    if (app.app.pid === undefined) return;
    const key = pidKey(app.deviceId, app.app.pid);
    if (appByPid.get(key) === app.id) appByPid.delete(key);
  }

  function noteAppTs(appId: string, ts: number): void {
    const prev = appLastTs.get(appId);
    if (prev === undefined || ts > prev) appLastTs.set(appId, ts);
  }

  function countAppLog(app: AppSession, level: LogEntry['level']): void {
    app.stats.logs++;
    if (levelRank(level) >= ERROR_RANK) app.stats.errors++;
    batcher.appChanged(app);
  }

  function processMapFor(deviceId: string): Map<number, ProcessUpdate> {
    let map = processes.get(deviceId);
    if (!map) {
      map = new Map();
      processes.set(deviceId, map);
    }
    return map;
  }

  /**
   * Over the cap, back to 75 % of it: dead processes first, then the oldest reports whatever their event
   * (iOS drivers report every syslog pid as 'seen' and never 'died'; without this the map grew toward every
   * pid ever seen and each insert past the cap scanned all of it). Map order is recency (setProcess).
   */
  function pruneProcesses(map: Map<number, ProcessUpdate>): void {
    if (map.size <= MAX_PROCESSES_PER_DEVICE) return;
    const target = Math.floor(MAX_PROCESSES_PER_DEVICE * 0.75);
    for (const [pid, p] of map) {
      if (map.size <= target) return;
      if (p.event === 'died') map.delete(pid);
    }
    for (const pid of map.keys()) {
      if (map.size <= target) return;
      map.delete(pid);
    }
  }

  function isWatchedProcess(deviceId: string, name: string): boolean {
    if (!name) return false;
    if (watched.has(name)) return true;
    return seenAppNames.get(deviceId)?.has(name) ?? false;
  }

  function ensureDesktopDevice(): void {
    if (devices.has(DESKTOP_DEVICE_ID)) return;
    const now = Date.now();
    storeDevice(undefined, {
      id: DESKTOP_DEVICE_ID,
      platform: 'other',
      kind: 'virtual',
      name: 'Desktop',
      connection: 'local',
      state: 'online',
      logs: { status: 'unavailable', detail: 'Requests replayed from Dürbün' },
      actions: [],
      firstSeen: now,
      lastSeen: now,
    });
  }

  function uniqueDeviceName(name: string): string {
    const taken = new Set([...devices.values()].map((d) => d.name));
    if (!taken.has(name)) return name;
    for (let i = 2; ; i++) if (!taken.has(`${name} (${i})`)) return `${name} (${i})`;
  }

  function removeDevice(id: string): void {
    devices.delete(id);
    processes.delete(id);
    deviceApps.remove(id);
    for (const [appId, app] of [...apps]) {
      if (app.deviceId !== id) continue;
      apps.delete(appId);
      sessionIndex.delete(sessionIndexKey(app.deviceId, app.sessionKey));
      unindexPid(app);
      appLastTs.delete(appId);
    }
    batcher.deviceRemoved(id);
  }

  /* ───────────── devices ───────────── */

  function upsertDevice(device: DeviceInfo): void {
    if (!device || typeof device.id !== 'string' || device.id.length === 0) return;
    const prev = devices.get(device.id);
    const now = Date.now();
    const next: DeviceInfo = { ...(prev ?? ({} as DeviceInfo)), ...device };
    // State explanations belong to the state they were sent with.
    if (!('stateDetail' in device)) delete next.stateDetail;
    if (!('stateCode' in device)) delete next.stateCode;
    // Only the driver session that runs a recording reports it; a fresh upsert without one has none.
    if (!('recording' in device)) delete next.recording;
    next.firstSeen = prev?.firstSeen ?? finite(device.firstSeen) ?? now;
    next.lastSeen = Math.max(finite(device.lastSeen) ?? now, prev?.lastSeen ?? 0);
    next.actions = Array.isArray(device.actions) ? [...device.actions] : (prev?.actions ?? []);
    next.logs = isRecord(device.logs) ? { ...device.logs } : (prev?.logs ?? { status: 'stopped' });
    setReaders(next, prev, device);
    storeDevice(prev, next);
  }

  function patchDevice(id: string, patch: Partial<DeviceInfo>): void {
    const prev = devices.get(id);
    if (!prev || !patch) return;
    const next: DeviceInfo = { ...prev, ...patch, id, firstSeen: prev.firstSeen };
    if (patch.logs) next.logs = { ...patch.logs };
    if (patch.actions) next.actions = [...patch.actions];
    setReaders(next, prev, patch);
    storeDevice(prev, next);
  }

  /** Readers merge per reader id: a driver reporting one reader keeps what the others reported. */
  function setReaders(next: DeviceInfo, prev: DeviceInfo | undefined, input: Partial<DeviceInfo>): void {
    const readers = 'readers' in input ? mergeReaders(prev?.readers, input.readers) : prev?.readers;
    if (readers) next.readers = readers;
    else delete next.readers;
  }

  function markDeviceDisconnected(id: string, detail?: string, code?: string): void {
    const prev = devices.get(id);
    if (!prev) return;
    if (prev.state === 'disconnected' && prev.stateDetail === detail && prev.stateCode === code) return;
    const next: DeviceInfo = { ...prev, state: 'disconnected', lastSeen: Date.now(), stateDetail: detail, stateCode: code };
    if (prev.logs.status === 'streaming' || prev.logs.status === 'starting') next.logs = { ...prev.logs, status: 'stopped' };
    delete next.recording;
    storeDevice(prev, next, detail);
    deviceApps.markDeviceStopped(id);
  }

  /* ───────────── logs & processes ───────────── */

  /** The live React Native SDK session that owns process `pid` on the device (console echo filter). */
  function rnSessionFor(deviceId: string, pid: number): string | undefined {
    const mapped = appByPid.get(pidKey(deviceId, pid));
    const candidates = mapped ? [apps.get(mapped)] : apps.values();
    for (const app of candidates) {
      if (!app || !app.connected || app.deviceId !== deviceId || app.sdk.platform !== 'react-native') continue;
      if (app.app.pid === pid || mapped === app.id) return app.id;
      if (deviceApps.get(deviceId, app.app.id)?.pids.includes(pid)) return app.id;
      if (processes.get(deviceId)?.get(pid)?.name === app.app.id) return app.id;
    }
    return undefined;
  }

  const consoleEcho = new ConsoleEchoFilter({ sessionFor: rnSessionFor, release: (deviceId, inputs) => appendDeviceLogs(deviceId, inputs) });

  function pushDeviceLogs(deviceId: string, entries: DeviceLogInput[]): void {
    if (!Array.isArray(entries) || entries.length === 0 || disposed) return;
    appendDeviceLogs(deviceId, consoleEcho.filter(deviceId, entries.filter((e) => !!e)));
  }

  function appendDeviceLogs(deviceId: string, entries: DeviceLogInput[]): void {
    if (entries.length === 0 || disposed) return;
    const procs = processes.get(deviceId);
    const out: LogEntry[] = [];
    for (const input of entries) {
      if (!input) continue;
      const entry: LogEntry = {
        ...input,
        id: nextLogId++,
        ts: finite(input.ts) ?? Date.now(),
        deviceId,
        source: 'device',
        level: normLevel(input.level),
        tag: typeof input.tag === 'string' ? input.tag : '',
        message: toMessage(input.message),
      };
      // Drivers name their exact origin (logcat, idevicesyslog, …); unknown values are dropped.
      const origin = normOrigin(input.origin);
      if (origin) entry.origin = origin;
      else delete entry.origin;
      if (entry.pid !== undefined) {
        if (!entry.process && procs) {
          const p = procs.get(entry.pid);
          if (p?.name) entry.process = p.name;
        }
        if (!entry.appId) {
          const appId = appByPid.get(pidKey(deviceId, entry.pid));
          if (appId) {
            entry.appId = appId;
            const app = apps.get(appId);
            if (app) countAppLog(app, entry.level);
          }
        }
      }
      out.push(entry);
    }
    appendLogs(out);
    deviceApps.noteLogs(deviceId, out);
  }

  function setProcess(update: Omit<ProcessUpdate, 'ts'> & { ts?: number }): void {
    if (!update || typeof update.deviceId !== 'string' || !Number.isFinite(update.pid)) return;
    const event = update.event === 'started' || update.event === 'died' ? update.event : 'seen';
    const name = typeof update.name === 'string' ? update.name : '';
    const map = processMapFor(update.deviceId);
    const prev = map.get(update.pid);
    if (prev && prev.name === name) {
      if (event === 'seen' && prev.event !== 'died') return; // periodic refresh, nothing new
      if (event === prev.event) return; // duplicate started/died report
    }
    const next: ProcessUpdate = {
      deviceId: update.deviceId,
      pid: update.pid,
      name: name || prev?.name || '',
      event,
      ts: finite(update.ts) ?? Date.now(),
    };
    map.delete(update.pid); // re-insert so iteration order follows recency (pruning drops the oldest)
    map.set(update.pid, next);
    batcher.processChanged(next);
    if (event !== 'seen') deviceApps.noteProcess(update.deviceId, update.pid, next.name);

    const key = pidKey(update.deviceId, update.pid);
    const mappedAppId = appByPid.get(key);
    const mappedApp = mappedAppId ? apps.get(mappedAppId) : undefined;
    let lineAppId: string | undefined;
    if (mappedApp) {
      const sameProcess = !next.name || next.name === mappedApp.app.id || next.name === mappedApp.app.processName;
      if (event === 'died') {
        // The app's process is gone; its pid may be reused by something else later.
        lineAppId = mappedApp.id;
        appByPid.delete(key);
      } else if (event === 'started' && !sameProcess) {
        appByPid.delete(key); // a different process now owns this pid
      } else if (sameProcess) {
        lineAppId = mappedApp.id;
      }
    }
    if ((event === 'started' || event === 'died') && isWatchedProcess(update.deviceId, next.name)) {
      pushSystem(update.deviceId, processLine(event, next.name, update.pid, lineAppId));
    }
    pruneProcesses(map);
  }

  /* ───────────── apps ───────────── */

  function registerApp(input: Omit<AppSession, 'id' | 'stats'>): AppSession {
    const now = Date.now();
    const key = sessionIndexKey(input.deviceId, input.sessionKey);
    const existingId = sessionIndex.get(key);
    const existing = existingId ? apps.get(existingId) : undefined;
    if (existing) {
      const wasConnected = existing.connected;
      unindexPid(existing);
      existing.sdk = copySdk(input.sdk);
      existing.app = { ...input.app };
      existing.transport = input.transport;
      existing.capabilities = [...(input.capabilities ?? [])];
      existing.actions = [...(input.actions ?? [])];
      existing.connected = true;
      existing.connectedAt = finite(input.connectedAt) ?? now;
      delete existing.disconnectedAt;
      indexPid(existing);
      rememberAppNames(existing);
      batcher.appChanged(existing);
      if (!wasConnected) pushSystem(existing.deviceId, appReconnectedLine(existing, deviceName(existing.deviceId)));
      return copyApp(existing);
    }
    const app: AppSession = {
      id: `app:${nextAppSeq++}`,
      sessionKey: input.sessionKey,
      deviceId: input.deviceId,
      sdk: copySdk(input.sdk),
      app: { ...input.app },
      transport: input.transport,
      connected: input.connected !== false,
      connectedAt: finite(input.connectedAt) ?? now,
      capabilities: [...(input.capabilities ?? [])],
      actions: [...(input.actions ?? [])],
      stats: { logs: 0, requests: 0, errors: 0 },
    };
    apps.set(app.id, app);
    sessionIndex.set(key, app.id);
    indexPid(app);
    rememberAppNames(app);
    batcher.appChanged(app);
    if (app.connected) pushSystem(app.deviceId, appConnectedLine(app, deviceName(app.deviceId)));
    return copyApp(app);
  }

  function patchApp(id: string, patch: Partial<AppSession>): void {
    const app = apps.get(id);
    if (!app || !patch) return;
    const { id: _ignored, ...rest } = patch;
    unindexPid(app);
    const oldKey = sessionIndexKey(app.deviceId, app.sessionKey);
    Object.assign(app, rest);
    const newKey = sessionIndexKey(app.deviceId, app.sessionKey);
    if (newKey !== oldKey) {
      if (sessionIndex.get(oldKey) === app.id) sessionIndex.delete(oldKey);
      sessionIndex.set(newKey, app.id);
    }
    if (rest.app) app.app = { ...rest.app };
    if (rest.stats) app.stats = { ...rest.stats };
    if (rest.actions) app.actions = [...rest.actions];
    if (rest.capabilities) app.capabilities = [...rest.capabilities];
    cleanUndefined(app);
    indexPid(app);
    rememberAppNames(app);
    batcher.appChanged(app);
  }

  function markAppDisconnected(id: string): void {
    const app = apps.get(id);
    if (!app || !app.connected) return;
    app.connected = false;
    app.disconnectedAt = Date.now();
    const failed = network.failPending(id, DISCONNECTED_ERROR, appLastTs.get(id));
    for (const entry of failed) settleNetRow(entry);
    network.endStreams(id, appLastTs.get(id) ?? app.disconnectedAt);
    appLastTs.delete(id); // only needed for requests still pending; a reconnect notes it again
    consoleEcho.sessionEnded(id);
    batcher.appChanged(app);
    pushSystem(app.deviceId, appDisconnectedLine(app, deviceName(app.deviceId), failed.length));
  }

  /** Session export of one app on one device (SPEC §10.2 / §10.5 device-app scope, hub/appScope.ts). */
  /** One app on a device (every session), or one session of it (`exact`): what that scope shows, nothing more. */
  function exportDeviceApp(deviceId: string, bundleId: string, exact?: string): SessionExport {
    const scope = appScope({ deviceId, bundleId, apps: apps.values(), deviceApps: deviceApps.values(deviceId), processes: processes.get(deviceId)?.values() ?? [], exact });
    const networkList: NetworkDetail[] = [];
    for (const e of network.values()) {
      if (!scope.network(e)) continue;
      const detail = network.detail(e.id, true);
      if (detail) networkList.push(detail);
    }
    const device = devices.get(deviceId);
    const deviceApp = deviceApps.get(deviceId, bundleId);
    const out: SessionExport = {
      format: 'durbun-session',
      version: 1,
      exportedAt: Date.now(),
      server: { version: SERVER_VERSION },
      devices: device ? [{ ...device }] : [],
      apps: [...apps.values()].filter((a) => scope.sessionIds.has(a.id)).map(copyApp),
      logs: allLogs().filter((e) => scope.logs(e) || (e.kind === 'marker' && e.deviceId === '')),
      network: networkList,
      metrics: metrics.all(scope.metrics),
    };
    if (deviceApp) out.deviceApps = [deviceApp];
    return out;
  }

  /* ───────────── hub object ───────────── */

  const hub: Hub = {
    upsertDevice,
    patchDevice,
    markDeviceDisconnected,
    pushDeviceLogs,
    setProcess,

    pushSystemLog(deviceId: string, input: SystemLogInput): LogEntry {
      return pushSystem(typeof deviceId === 'string' ? deviceId : '', input ?? { message: '' });
    },

    pushMetrics(samples: MetricSample[]): void {
      if (!Array.isArray(samples) || samples.length === 0) return;
      const clean: MetricSample[] = [];
      for (const s of samples) {
        if (!s || typeof s.deviceId !== 'string') continue;
        const sample = sanitizeSample(s);
        if (!sample) continue;
        metrics.push(sample);
        clean.push(sample);
      }
      batcher.metricsAdded(clean);
    },

    notice(notice: UiNotice): void {
      if (!notice || disposed) return;
      callAll(noticeListeners, { ...notice }, 'onNotice');
    },

    getDevices: () => [...devices.values()].map((d) => ({ ...d })),
    getDevice: (id) => {
      const d = devices.get(id);
      return d ? { ...d } : undefined;
    },
    getApps: () => [...apps.values()].map(copyApp),
    getApp: (id) => {
      const a = apps.get(id);
      return a ? copyApp(a) : undefined;
    },
    getDeviceApps: () => deviceApps.list(),

    upsertDeviceApp(input) {
      if (disposed) {
        const deviceId = typeof input?.deviceId === 'string' ? input.deviceId : '';
        const id = typeof input?.id === 'string' ? input.id : '';
        return { key: deviceAppKey(deviceId, id), deviceId, id, buildType: 'unknown', install: { source: 'unknown' }, pids: [], running: false, lastActivity: Date.now() };
      }
      return deviceApps.upsert(input);
    },

    removeDeviceApps(deviceId, ids) {
      if (disposed) return;
      deviceApps.remove(deviceId, ids);
    },

    registerApp,
    patchApp,
    markAppDisconnected,

    pushAppLog(appId, log) {
      const app = apps.get(appId);
      if (!app || !log || disposed) return undefined;
      const ts = finite(log.ts) ?? Date.now();
      noteAppTs(appId, ts);
      const kind = normKind(log.kind) ?? 'text';
      let level = normLevel(log.level);
      if (kind === 'crash' && levelRank(level) < ERROR_RANK) level = 'fatal';
      else if ((kind === 'flutter-error' || kind === 'anr') && levelRank(level) < ERROR_RANK) level = 'error';
      const entry: LogEntry = {
        id: nextLogId++,
        ts,
        deviceId: app.deviceId,
        appId,
        source: 'app',
        origin: appOrigin(app),
        level,
        tag: typeof log.tag === 'string' && log.tag.length > 0 ? log.tag : 'app',
        message: toMessage(log.message),
        kind,
      };
      attachAppProcess(entry, app);
      const tid = finite(log.tid);
      if (tid !== undefined) entry.tid = tid;
      if (log.data !== undefined) entry.data = log.data;
      if (isRecord(log.error)) entry.error = log.error;
      countAppLog(app, level);
      appendLogs([entry]);
      if (kind === 'text' && app.sdk.platform === 'react-native') consoleEcho.noteSdkLine(appId, entry.message, entry.tag);
      return entry;
    },

    netRequest(appId, msg) {
      const app = apps.get(appId);
      if (!app || !msg || disposed) return;
      noteAppTs(appId, msg.ts);
      const id = `${appId}:${msg.id}`;
      const { entry, first } = network.request(id, appId, app.deviceId, msg);
      if (!first) return;
      app.stats.requests++;
      batcher.appChanged(app);
      const row: LogEntry = {
        id: nextLogId++,
        ts: msg.ts,
        deviceId: app.deviceId,
        appId,
        source: 'app',
        origin: appOrigin(app),
        level: 'info',
        tag: 'network',
        message: `${entry.method} ${entry.url}`,
        kind: 'network',
        netId: id,
      };
      attachAppProcess(row, app);
      appendLogs([row]);
      if (entry.state === 'pending') trackNetRow(id, row);
      else row.level = networkLogLevel(entry);
    },

    netResponse(appId, msg, opts) {
      const app = apps.get(appId);
      if (!app || !msg || disposed) return;
      noteAppTs(appId, msg.ts);
      const streaming = opts?.streaming ?? app.capabilities.includes('streams');
      settleNetRow(network.response(`${appId}:${msg.id}`, appId, app.deviceId, msg, streaming));
    },

    netError(appId, msg) {
      const app = apps.get(appId);
      if (!app || !msg || disposed) return;
      noteAppTs(appId, msg.ts);
      settleNetRow(network.error(`${appId}:${msg.id}`, appId, app.deviceId, msg));
    },

    netStream(appId, msg) {
      const app = apps.get(appId);
      if (!app || !msg || disposed) return;
      noteAppTs(appId, msg.ts);
      network.streamMessage(`${appId}:${msg.id}`, msg);
    },

    netTooLarge(appId, input) {
      const app = apps.get(appId);
      if (!app || !input || typeof input.id !== 'string' || !input.id || disposed) return;
      const ts = finite(input.ts) ?? appLastTs.get(appId) ?? Date.now();
      const id = `${appId}:${input.id}`;
      const info = { part: input.part, bytes: Math.max(0, Math.floor(finite(input.bytes) ?? 0)), limit: Math.max(0, Math.floor(finite(input.limit) ?? 0)) };
      const mb = (n: number) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
      if (input.part === 'request') {
        if (!network.get(id)) {
          hub.netRequest(appId, {
            type: 'net.request',
            id: input.id,
            ts,
            method: typeof input.method === 'string' && input.method ? input.method.slice(0, 32).toUpperCase() : '?',
            url: typeof input.url === 'string' ? input.url : '',
            headers: [],
            source: 'sdk',
          });
        }
        network.markTooLarge(id, info);
        return;
      }
      const status = finite(input.status);
      hub.netError(appId, {
        type: 'net.error',
        id: input.id,
        ts,
        error: `Dürbün could not receive this response: its message (${mb(info.bytes)}) is over the ${mb(info.limit)} limit. The app itself got the response.`,
      });
      network.markTooLarge(id, info, status !== undefined ? Math.floor(status) : undefined);
    },

    pushAppMetrics(appId, sample) {
      const app = apps.get(appId);
      if (!app || !sample || disposed) return;
      const clean = sanitizeSample({ ...sample, deviceId: app.deviceId, appId, pid: sample.pid ?? app.app.pid });
      if (!clean) return;
      noteAppTs(appId, clean.ts);
      metrics.push(clean);
      batcher.metricsAdded([clean]);
    },

    recordDesktopRequest(detail: NetworkDetail): NetworkEntry {
      ensureDesktopDevice();
      let id = typeof detail.id === 'string' && detail.id.length > 0 && !network.has(detail.id) ? detail.id : '';
      while (!id || network.has(id)) id = `replay:${nextReplaySeq++}`;
      const entry = network.record({
        ...detail,
        id,
        deviceId: DESKTOP_DEVICE_ID,
        source: detail.source || 'replay',
        startTs: finite(detail.startTs) ?? Date.now(),
        requestHeaders: Array.isArray(detail.requestHeaders) ? detail.requestHeaders : [],
      });
      const row: LogEntry = {
        id: nextLogId++,
        ts: entry.startTs,
        deviceId: DESKTOP_DEVICE_ID,
        source: 'system',
        origin: 'durbun',
        // A desktop request is recorded with its outcome.
        level: networkLogLevel(entry),
        tag: 'network',
        message: `${entry.method} ${entry.url}`,
        kind: 'network',
        netId: entry.id,
      };
      if (entry.appId) row.appId = entry.appId;
      appendLogs([row]);
      return { ...entry };
    },

    getLogs(opts = {}) {
      // One id-ordered view over the kept crashes (all older) and the ring.
      const kept = keptCrashes.size;
      const total = kept + logs.size;
      let start = 0;
      if (opts.afterId !== undefined) {
        const inKept = keptCrashes.upperBound(opts.afterId, (e) => e.id);
        start = inKept < kept ? inKept : kept + logs.upperBound(opts.afterId, (e) => e.id);
      }
      const end = opts.limit === undefined ? total : Math.min(total, start + Math.max(0, Math.floor(opts.limit)));
      if (start >= kept) return logs.slice(start - kept, end - kept);
      const head = keptCrashes.slice(start, Math.min(end, kept));
      return end > kept ? head.concat(logs.slice(0, end - kept)) : head;
    },
    getLogCount: () => keptCrashes.size + logs.size,
    getLimits: (): StoreLimits => ({
      maxLogEntries: logs.capacity,
      maxLogBytes,
      maxKeptCrashes: MAX_KEPT_CRASH_LOGS,
      maxNetworkEntries: Math.max(1, Math.floor(settings.maxNetworkEntries)),
      maxBodyStoreBytes: limitsFrom(settings).maxBodyBytes,
    }),
    getEvictions: evictionSnapshot,
    getEpoch: epoch,
    getLastLogId: () => nextLogId - 1,
    getNetworkSeq: () => network.seq,
    getNetworkSince: (seq: number) => network.changedSince(seq).map((e) => ({ ...e })),
    getNetworkIds: () => network.ids(),
    getMockHits: () => mockHits.snapshot(),
    retainMockHits(ruleIds: string[]): void {
      if (!Array.isArray(ruleIds)) return;
      // The next batch carries the map even when nothing else changed.
      if (mockHits.retain(ruleIds.filter((id) => typeof id === 'string'))) batcher.touch();
    },
    getNetwork: () => network.list().map((e) => ({ ...e })),
    getNetworkDetail: (id) => network.detail(id),
    getStreamMessages: (id, opts = {}) => {
      const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 500)), 2_000);
      return network.streamPage(id, Math.max(0, Math.floor(opts.after ?? 0)), limit);
    },
    searchNetwork: (text, opts) => network.search(typeof text === 'string' ? text : '', opts ?? {}),
    searchNetworkAsync: (text, opts) => network.searchAsync(typeof text === 'string' ? text : '', opts ?? {}),
    getMetrics: () => metrics.all(),
    getProcesses: () => {
      const out: ProcessUpdate[] = [];
      for (const map of processes.values()) for (const p of map.values()) out.push(p);
      return out;
    },

    clear(target: ClearTarget, scope = {}) {
      const deviceId = scope.deviceId || undefined;
      const appId = scope.appId || undefined;
      // One app of the device: with a device, without a session (as in exportSession).
      const bundleId = deviceId && !appId ? scope.bundleId || undefined : undefined;
      // Queued changes go out first so the `cleared` event never precedes data it should remove.
      batcher.flush();
      const unscoped = !deviceId && !appId;
      const inScope = (e: { deviceId: string; appId?: string }) =>
        (!deviceId || e.deviceId === deviceId) && (!appId || e.appId === appId);
      // App scopes remove what the UI's scope shows (hub/appScope.ts), so the device lines of the app's processes
      // go too: one app of the device (bundleId) or one session with its process (appId, the exact scope).
      // Markers of the app's device go with it; global markers stay, as in a device's clear.
      const session = appId ? apps.get(appId) : undefined;
      const ownedBy = (device: string, bundle: string, exact?: string) =>
        appScope({ deviceId: device, bundleId: bundle, exact, apps: apps.values(), deviceApps: deviceApps.values(device), processes: processes.get(device)?.values() ?? [] });
      const owned =
        deviceId && bundleId
          ? ownedBy(deviceId, bundleId)
          : session && (!deviceId || session.deviceId === deviceId)
            ? ownedBy(session.deviceId, session.app.id, session.id)
            : undefined;
      const logInScope = owned ? owned.logs : inScope;
      // The eviction counts of what is cleared go too (a new start for that scope).
      if (target !== 'metrics') {
        if (unscoped) evictions.reset(target !== 'network', target !== 'logs');
        else if (owned) evictions.forgetApp(deviceId ?? session!.deviceId, owned.sessionIds, owned.ownsProcess);
        else if (deviceId) evictions.forgetDevice(deviceId, [...apps.values()].filter((a) => a.deviceId === deviceId).map((a) => a.id));
        else if (appId) evictions.forgetApp('', [appId]);
      }
      clearSeq++;
      const appInScope = (a: AppSession) =>
        owned ? owned.sessionIds.has(a.id) : (!deviceId || a.deviceId === deviceId) && (!appId || a.id === appId);

      if (target === 'logs' || target === 'all') {
        // Device apps' crash counts go with their records (SPEC §10.2). A device / unscoped clear removes all
        // of them. An app's or a session's clear removes only the records its scope shows (a session's: not
        // an earlier launch's record, whose pid is in data only), so only those come off the count.
        const removedRecords = appId || bundleId ? new Map<string, number>() : undefined;
        if (removedRecords) {
          const countedFor = crashRecordCounter();
          const visit = (e: LogEntry) => {
            const key = countedFor(e);
            if (key !== undefined && logInScope(e)) removedRecords.set(key, (removedRecords.get(key) ?? 0) + 1);
          };
          keptCrashes.forEach(visit);
          logs.forEach(visit);
        }
        if (unscoped) {
          logs.clear();
          keptCrashes.clear();
        } else {
          logs.retain((e) => !logInScope(e));
          keptCrashes.retain((e) => !logInScope(e));
        }
        recountLogBytes();
        for (const app of apps.values()) {
          if (!appInScope(app) || (app.stats.logs === 0 && app.stats.errors === 0)) continue;
          app.stats.logs = 0;
          app.stats.errors = 0;
          batcher.appChanged(app);
        }
        if (removedRecords) deviceApps.forgetCrashReports(removedRecords);
        else deviceApps.resetCrashReports((a) => !deviceId || a.deviceId === deviceId);
      }
      if (target === 'network' || target === 'all') {
        if (unscoped) network.clear();
        else network.removeWhere(owned ? owned.network : inScope);
        for (const app of apps.values()) {
          if (!appInScope(app) || app.stats.requests === 0) continue;
          app.stats.requests = 0;
          batcher.appChanged(app);
        }
      }
      if (target === 'metrics' || target === 'all') {
        if (unscoped) metrics.clear();
        else metrics.removeWhere(owned ? owned.metrics : inScope);
      }
      if (target === 'all' && !appId && !bundleId) {
        // Devices that are gone (or only hold imported/replayed data) disappear with their data.
        for (const device of [...devices.values()]) {
          if (deviceId && device.id !== deviceId) continue;
          const removable =
            device.id === DESKTOP_DEVICE_ID || device.id.startsWith(IMPORT_DEVICE_PREFIX) || device.state === 'disconnected';
          const hasLiveApp = [...apps.values()].some((a) => a.deviceId === device.id && a.connected);
          if (removable && !hasLiveApp) removeDevice(device.id);
        }
      }
      const event: ClearEvent = { target, epoch: epoch(), evictions: evictionSnapshot() };
      evictions.takeIfChanged();
      if (deviceId) event.deviceId = deviceId;
      if (appId) event.appId = appId;
      if (bundleId) event.bundleId = bundleId;
      callAll(clearedListeners, event, 'onCleared');
    },

    addMarker(label?: string, deviceId?: string): LogEntry {
      markerSeq++;
      return pushSystem(deviceId ?? '', markerLine(label, markerSeq));
    },

    exportSession(scope = {}): SessionExport {
      const deviceId = scope.deviceId || undefined;
      const appId = scope.appId || undefined;
      // One app of a device, with or without a session (an SDK-less store build): what its scope shows.
      if (deviceId && !appId && scope.bundleId) return exportDeviceApp(deviceId, scope.bundleId);
      // One session: the same rule, so the file also holds the device's connect / log-stream lines its scope shows.
      const session = appId ? apps.get(appId) : undefined;
      if (session && (!deviceId || deviceId === session.deviceId)) return exportDeviceApp(session.deviceId, session.app.id, session.id);
      const unscoped = !deviceId && !appId;
      const inScope = (e: { deviceId: string; appId?: string }) =>
        (!deviceId || e.deviceId === deviceId) && (!appId || e.appId === appId);
      const logList = allLogs().filter((e) => inScope(e) || (e.kind === 'marker' && e.deviceId === ''));
      const networkList: NetworkDetail[] = [];
      for (const e of network.values()) {
        if (!inScope(e)) continue;
        const detail = network.detail(e.id, true);
        if (detail) networkList.push(detail);
      }
      const appList = [...apps.values()]
        .filter((a) => (!deviceId || a.deviceId === deviceId) && (!appId || a.id === appId))
        .map(copyApp);
      let deviceList: DeviceInfo[];
      if (unscoped) deviceList = [...devices.values()].map((d) => ({ ...d }));
      else {
        const ids = new Set<string>();
        if (deviceId) ids.add(deviceId);
        for (const a of appList) ids.add(a.deviceId);
        for (const n of networkList) ids.add(n.deviceId);
        for (const l of logList) if (l.deviceId) ids.add(l.deviceId);
        deviceList = [...ids].map((id) => devices.get(id)).filter((d): d is DeviceInfo => !!d).map((d) => ({ ...d }));
      }
      // Device apps of the exported devices (an app-scoped export keeps only that app's bundle id).
      const exportedDevices = new Set(deviceList.map((d) => d.id));
      const scopedBundle = appId ? apps.get(appId) : undefined;
      const deviceAppList = deviceApps
        .values()
        .filter((a) => exportedDevices.has(a.deviceId) && (!scopedBundle || (a.deviceId === scopedBundle.deviceId && a.id === scopedBundle.app.id)))
        .map(copyDeviceApp);
      const out: SessionExport = {
        format: 'durbun-session',
        version: 1,
        exportedAt: Date.now(),
        server: { version: SERVER_VERSION },
        devices: deviceList,
        apps: appList,
        logs: logList,
        network: networkList,
        metrics: metrics.all(inScope),
      };
      if (deviceAppList.length > 0) out.deviceApps = deviceAppList;
      return out;
    },

    importSession(data: SessionExport, label: string): { deviceIds: string[] } {
      if (!isRecord(data) || data.format !== 'durbun-session') {
        throw new Error('Not a Dürbün session file (expected format "durbun-session")');
      }
      const versionProblem = sessionVersionProblem(data.version);
      if (versionProblem) throw new Error(versionProblem);
      if (data.version > 1) {
        logger.warn(`importing a session file of newer version ${data.version}; unknown fields are ignored`);
      }
      const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
      const labelText = (typeof label === 'string' && label.trim()) || 'import';
      const now = Date.now();
      const createdDevices: string[] = [];
      const deviceMap = new Map<string, string>();

      const createImportDevice = (srcId: string, src?: DeviceInfo): string => {
        const id = `${IMPORT_DEVICE_PREFIX}${nextImportSeq++}`;
        const baseName = src?.name || (srcId ? srcId : labelText);
        const device: DeviceInfo = {
          ...(src ?? { platform: 'other', kind: 'virtual', name: baseName, connection: 'unknown', firstSeen: now, lastSeen: now }),
          id,
          name: uniqueDeviceName(`${IMPORT_NAME_PREFIX}${baseName}`),
          connection: 'unknown',
          state: 'disconnected',
          stateDetail: `Imported from ${labelText}`,
          stateCode: 'device.imported',
          logs: { status: 'stopped' },
          actions: [],
          firstSeen: now,
          lastSeen: now,
        } as DeviceInfo;
        devices.set(id, device);
        batcher.deviceChanged(device);
        deviceMap.set(srcId, id);
        createdDevices.push(id);
        return id;
      };
      const mapDevice = (srcId: string): string => {
        const known = deviceMap.get(srcId);
        if (known) return known;
        if (srcId === '' && createdDevices.length > 0) return createdDevices[0]!;
        return createImportDevice(srcId);
      };

      for (const raw of list(data.devices)) {
        const d = sanitizeImportedDevice(raw);
        if (d && !deviceMap.has(d.id)) createImportDevice(d.id, d);
      }

      const appMap = new Map<string, AppSession>();
      for (const raw of list(data.apps)) {
        const a = sanitizeImportedApp(raw);
        if (!a || appMap.has(a.id)) continue;
        const id = `app:${nextAppSeq++}`;
        const app: AppSession = {
          ...a,
          id,
          deviceId: mapDevice(a.deviceId),
          sessionKey: `import:${id}:${a.sessionKey}`,
          transport: 'import',
          connected: false,
          disconnectedAt: a.disconnectedAt ?? a.connectedAt,
          actions: [],
          stats: { logs: 0, requests: 0, errors: 0 },
        };
        apps.set(id, app);
        appMap.set(a.id, app);
      }

      const netIdMap = new Map<string, string>();
      /** Level of each imported request's row (files of older versions wrote every request row as info). */
      const netLevels = new Map<string, LogLevel>();
      for (const raw of list(data.network)) {
        const n = sanitizeImportedNetwork(raw);
        if (!n) continue;
        const deviceId = mapDevice(n.deviceId);
        let id = `${deviceId}:${n.id}`;
        if (network.has(id)) id = `${deviceId}:${n.id}:${nextReplaySeq++}`;
        const app = n.appId ? appMap.get(n.appId) : undefined;
        netIdMap.set(n.id, id);
        netLevels.set(id, networkLogLevel(network.record({ ...n, id, deviceId, appId: app?.id })));
        if (app) app.stats.requests++;
      }

      const sourceLogs: LogEntry[] = [];
      for (const raw of list(data.logs)) {
        const e = sanitizeImportedLog(raw);
        if (e) sourceLogs.push(e);
      }
      sourceLogs.sort((a, b) => a.id - b.id);
      const imported: LogEntry[] = [];
      for (const e of sourceLogs) {
        const entry: LogEntry = { ...e, id: nextLogId++, deviceId: mapDevice(e.deviceId) };
        delete entry.appId;
        const app = e.appId ? appMap.get(e.appId) : undefined;
        if (app) {
          entry.appId = app.id;
          if (e.kind !== 'network' && e.source !== 'system') {
            app.stats.logs++;
            if (levelRank(entry.level) >= ERROR_RANK) app.stats.errors++;
          }
        }
        if (e.netId) {
          const mapped = netIdMap.get(e.netId);
          if (mapped) {
            entry.netId = mapped;
            const level = e.kind === 'network' ? netLevels.get(mapped) : undefined;
            if (level && levelRank(level) > levelRank(entry.level)) entry.level = level;
          }
        }
        imported.push(entry);
      }
      appendLogs(imported, false); // historical data: not tapped by live log watchers

      const samples: MetricSample[] = [];
      for (const raw of list(data.metrics)) {
        if (!isRecord(raw) || typeof raw.deviceId !== 'string') continue;
        const appId = typeof raw.appId === 'string' ? appMap.get(raw.appId)?.id : undefined;
        const sample = sanitizeSample({ ...(raw as Partial<MetricSample>), deviceId: mapDevice(raw.deviceId), appId });
        if (!sample) continue;
        metrics.push(sample);
        samples.push(sample);
      }
      batcher.metricsAdded(samples);
      for (const app of appMap.values()) batcher.appChanged(app);

      // Device apps travel with their (imported) device: a snapshot, nothing runs any more.
      let importedDeviceApps = 0;
      for (const raw of list(data.deviceApps)) {
        if (!isRecord(raw) || typeof raw.deviceId !== 'string' || typeof raw.id !== 'string' || !raw.id) continue;
        const deviceId = deviceMap.get(raw.deviceId);
        if (!deviceId) continue;
        const crashReports = finite(raw.crashReports);
        deviceApps.upsert({
          ...(raw as Partial<DeviceApp>),
          deviceId,
          id: raw.id,
          pids: [],
          running: false,
          lastActivity: finite(raw.lastActivity) ?? now,
          crashReportsDelta: crashReports !== undefined && crashReports > 0 ? crashReports : undefined,
        });
        importedDeviceApps++;
      }
      logger.info(
        `imported "${labelText}": ${createdDevices.length} device(s), ${appMap.size} app(s), ${imported.length} log(s), ${netIdMap.size} request(s), ${importedDeviceApps} device app(s)`,
      );
      return { deviceIds: createdDevices };
    },

    setSettings(next: ServerSettings): void {
      if (!next) return;
      settings = { ...next };
      const shrunk = logs.setCapacity(settings.maxLogEntries);
      for (const evicted of shrunk) keepIfCrash(evicted);
      if (shrunk.length > 0) recountLogBytes();
      network.setLimits(limitsFrom(settings));
      // The UI follows the oldest line still held; a batch tells it.
      if (shrunk.length > 0) batcher.touch();
      watched = new Set(Array.isArray(settings.watchedApps) ? settings.watchedApps : []);
    },

    subscribe(listener: (change: HubChange) => void): () => void {
      return batcher.subscribe(listener);
    },
    onCleared(listener) {
      clearedListeners.add(listener);
      return () => {
        clearedListeners.delete(listener);
      };
    },
    onNotice(listener) {
      noticeListeners.add(listener);
      return () => {
        noticeListeners.delete(listener);
      };
    },
    onLogs(listener) {
      logTaps.add(listener);
      return () => {
        logTaps.delete(listener);
      };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      consoleEcho.dispose();
      deviceApps.dispose();
      batcher.dispose();
      clearedListeners.clear();
      noticeListeners.clear();
      logTaps.clear();
    },
  };
  return hub;
}
