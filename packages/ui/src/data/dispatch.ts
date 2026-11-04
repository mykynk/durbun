import { PROTOCOL_VERSION, type ServerSettings, type ServerToUi } from '@durbun/protocol';
import { logStore } from './logStore';
import { compileScope } from './scope';
import { networkStore } from './networkStore';
import { metricsStore } from './metricsStore';
import { hubActions, useHub, appGroupKey, deviceAppKey } from './stores/hub';
import { useConnection } from './stores/connection';
import { setMocksFromServer, setServerSettingsFromServer } from './stores/server';
import { ALL_SCOPE, setScope, useScopeStore } from './stores/scope';
import { flushPendingCommands, handleReply } from './commands';
import { emitNotice, emitResync, emitServerMessage } from './events';

function applyLimits(settings: ServerSettings): void {
  logStore.setMaxEntries(settings.maxLogEntries);
  networkStore.setMaxEntries(settings.maxNetworkEntries);
}

/** Make sure the scope still points at something that exists (after resync / device removal). */
export function validateScope(): void {
  const { scope, hint } = useScopeStore.getState();
  const { devices, apps, deviceApps } = useHub.getState();
  if (scope.kind === 'all') return;
  if (scope.kind === 'device') {
    if (!devices[scope.deviceId]) setScope(ALL_SCOPE);
    return;
  }
  if (scope.kind === 'deviceApp') {
    const key = deviceAppKey(scope.deviceId, scope.bundleId);
    // The app stays in scope while its device is there and someone (device report or SDK session) knows it.
    if (deviceApps[key] || Object.values(apps).some((a) => appGroupKey(a) === key)) return;
    if (devices[scope.deviceId]) setScope({ kind: 'device', deviceId: scope.deviceId });
    else setScope(ALL_SCOPE);
    return;
  }
  const app = apps[scope.appId];
  const matchesHint = (a: { deviceId: string; app: { id: string } }) =>
    (!hint.bundleId || a.app.id === hint.bundleId) && (!hint.deviceId || a.deviceId === hint.deviceId);
  if (app && matchesHint(app)) return;
  if (hint.bundleId && hint.deviceId) {
    const candidates = Object.values(apps)
      .filter((a) => appGroupKey(a) === `${hint.deviceId}|${hint.bundleId}`)
      .sort((a, b) => Number(b.connected) - Number(a.connected) || b.connectedAt - a.connectedAt);
    if (candidates[0]) {
      setScope({ kind: 'app', appId: candidates[0].id }, hint);
      return;
    }
    // No session any more (server restarted), but the device still reports the app: keep it in scope.
    if (deviceApps[deviceAppKey(hint.deviceId, hint.bundleId)]) {
      setScope({ kind: 'deviceApp', deviceId: hint.deviceId, bundleId: hint.bundleId }, hint);
      return;
    }
  }
  if (hint.deviceId && devices[hint.deviceId]) setScope({ kind: 'device', deviceId: hint.deviceId });
  else setScope(ALL_SCOPE);
}

/**
 * The hub's clear, applied to the stores (packages/server/src/hub/index.ts): an app scope removes what the scope
 * shows — one app of the device (`bundleId`) or one session with its process (`appId`, the exact scope) — except
 * markers of other devices and global ones (every scope shows them; the hub keeps them).
 */
function clearStores(msg: Extract<ServerToUi, { type: 'cleared' }>): void {
  const { target, deviceId, appId } = msg;
  const bundleId = deviceId && !appId ? msg.bundleId : undefined;
  const all = !deviceId && !appId;
  const matches = (d: string, a?: string) => (!deviceId || d === deviceId) && (!appId || a === appId);
  const hub = useHub.getState();
  const session = appId ? hub.apps[appId] : undefined;
  const owned =
    deviceId && bundleId
      ? compileScope({ kind: 'deviceApp', deviceId, bundleId }, hub)
      : session && (!deviceId || session.deviceId === deviceId)
        ? compileScope({ kind: 'app', appId: session.id, exact: true }, hub)
        : undefined;
  if (target === 'logs' || target === 'all') {
    if (all) logStore.reset();
    else if (owned) logStore.removeWhere((e) => (e.kind === 'marker' && e.appId === undefined ? e.deviceId === owned.deviceId : owned.logs(e)));
    else logStore.removeWhere((e) => matches(e.deviceId, e.appId));
  }
  if (target === 'network' || target === 'all') {
    const ids = owned?.appIds;
    if (all) networkStore.reset();
    else networkStore.removeWhere((e) => (ids ? e.appId !== undefined && ids.has(e.appId) : matches(e.deviceId, e.appId)));
  }
  if (target === 'metrics' || target === 'all') {
    if (all) metricsStore.reset();
    else metricsStore.removeWhere((s) => (owned ? owned.metrics(s) : matches(s.deviceId, s.appId)));
  }
}

/** Devices removed by the server: their apps, processes and metric series go too; the scope is re-checked. */
function removeDevices(ids: string[]): void {
  const gone = new Set(ids);
  hubActions.removeDevices(ids);
  metricsStore.removeWhere((s) => gone.has(s.deviceId));
  validateScope();
}

function markLive(): void {
  if (useConnection.getState().status === 'syncing') useConnection.setState({ status: 'live' });
}

/** Apply one WS /ui message to the stores, then notify `onServerMessage` listeners. */
export function handleServerMessage(msg: ServerToUi): void {
  switch (msg.type) {
    case 'hello': {
      useConnection.setState({
        status: 'syncing',
        server: msg.server,
        everConnected: true,
        attempt: 0,
        nextRetryAt: null,
        lastError: null,
        connectedAt: Date.now(),
        historyReceived: 0,
        protocolMismatch: typeof msg.server?.protocol === 'number' && msg.server.protocol !== PROTOCOL_VERSION,
      });
      if (msg.settings) {
        setServerSettingsFromServer(msg.settings);
        applyLimits(msg.settings);
      }
      flushPendingCommands();
      break;
    }
    case 'snapshot': {
      logStore.reset();
      networkStore.reset();
      metricsStore.reset();
      hubActions.replaceAll({
        devices: msg.devices ?? [],
        apps: msg.apps ?? [],
        drivers: msg.drivers ?? [],
        processes: msg.processes ?? [],
        deviceApps: msg.deviceApps ?? [],
      });
      networkStore.upsert(msg.network ?? [], { history: true });
      metricsStore.push(msg.metrics ?? []);
      setMocksFromServer(msg.mocks ?? []);
      useConnection.setState({ expectedLogCount: msg.logCount ?? 0, historyReceived: 0 });
      validateScope();
      emitResync();
      if (!msg.logCount) markLive();
      break;
    }
    case 'history': {
      logStore.append(msg.logs ?? [], { history: true });
      useConnection.setState((s) => ({ historyReceived: s.historyReceived + (msg.logs?.length ?? 0) }));
      if (msg.done) markLive();
      break;
    }
    case 'batch': {
      // Live batches only start after history; seeing one means we are in sync.
      markLive();
      if (msg.devices?.length) hubActions.upsertDevices(msg.devices);
      if (msg.apps?.length) hubActions.upsertApps(msg.apps);
      if (msg.processes?.length) hubActions.applyProcesses(msg.processes);
      if (msg.deviceApps?.length) hubActions.upsertDeviceApps(msg.deviceApps);
      // A removed device app stays in scope until the next resync (its rows are still on screen).
      if (msg.removedDeviceApps?.length) hubActions.removeDeviceApps(msg.removedDeviceApps);
      if (msg.logs?.length) logStore.append(msg.logs);
      if (msg.network?.length) networkStore.upsert(msg.network);
      if (msg.metrics?.length) metricsStore.push(msg.metrics);
      if (msg.removedDevices?.length) removeDevices(msg.removedDevices);
      break;
    }
    case 'cleared':
      // Hub semantics: `cleared` comes first; with target 'all' (no appId) the server also drops devices that
      // are gone / imported / desktop — those arrive afterwards as `batch.removedDevices`.
      clearStores(msg);
      break;
    case 'mocks':
      setMocksFromServer(msg.rules ?? []);
      break;
    case 'settings':
      setServerSettingsFromServer(msg.settings);
      applyLimits(msg.settings);
      break;
    case 'drivers':
      hubActions.setDrivers(msg.drivers ?? []);
      break;
    case 'notice': {
      const { type: _type, ...notice } = msg;
      emitNotice(notice);
      break;
    }
    case 'reply':
      handleReply(msg);
      break;
    default:
      break;
  }
  emitServerMessage(msg);
}
