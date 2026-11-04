/**
 * Routing of UI commands (UiToServer) to the hub, drivers, SDK layer, VM module and config, with the reply
 * `data` shapes from the protocol's reply table. Every failure becomes `{ ok: false, error, code }` —
 * a broken driver or a hung action never takes the server (or the UI connection) down.
 */
import type {
  ClearTarget,
  DeviceActionId,
  DeviceActionResult,
  ReplayOverrides,
  ToolCheck,
  UiNotice,
} from '@durbun/protocol';
import { ConfigValidationError, isPlainObject, type ConfigStore } from '../config';
import type { DeviceDriver, FlutterVmModule, Hub, Logger, SdkLayer } from '../types';
import { replayRequest, ReplayError } from './replay';
import { errorMessage } from './util';

export interface CommandReply {
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

/** The UI connection a command came from (notices go back to it; metric watches are tied to it). */
export interface CommandClient {
  readonly id: number;
  notice(notice: UiNotice): void;
}

export interface CommandDeps {
  hub: Hub;
  sdk: Pick<SdkLayer, 'sendCommand'>;
  config: Pick<ConfigStore, 'updateSettings' | 'setMocks' | 'settings'>;
  logger: Logger;
  /** Every device driver that can own devices (platform drivers + demo). */
  drivers: () => DeviceDriver[];
  vm: FlutterVmModule | null;
  setDemo(enabled: boolean): Promise<boolean>;
  runDoctor(): Promise<ToolCheck[]>;
  /** settings.update changed the effective allowLan: rebind listeners, tell the user. */
  onLanChanged(lan: boolean): Promise<void>;
  replayTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const CLEAR_TARGETS: ClearTarget[] = ['logs', 'network', 'metrics', 'all'];
const DEFAULT_ACTION_TIMEOUT_MS = 2 * 60_000;
const APP_COMMAND_TIMEOUT_MS = 15_000;
const VM_ATTACH_TIMEOUT_MS = 60_000;

const ok = (data: unknown = null): CommandReply => ({ ok: true, data });
const fail = (error: string, code: string): CommandReply => ({ ok: false, error, code });

function invalid(message: string): CommandError {
  return new CommandError(message, 'command.invalid');
}

function reqString(v: unknown, name: string, max = 10_000): string {
  if (typeof v !== 'string' || v.trim() === '') throw invalid(`${name} is required`);
  if (v.length > max) throw invalid(`${name} is too long`);
  return v;
}

function optString(v: unknown, name: string, max = 10_000): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return reqString(v, name, max);
}

function optParams(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (!isPlainObject(v)) throw invalid('params must be an object');
  return v;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CommandError(`${what} did not finish within ${Math.round(ms / 1000)} s`, code)), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function actionTimeoutMs(action: string, params: Record<string, unknown>): number {
  if (action === 'app-install') return 10 * 60_000;
  if (action === 'screen-record') {
    const seconds = Number(params.durationSec);
    return (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) : 180) * 1000 + 2 * 60_000;
  }
  return DEFAULT_ACTION_TIMEOUT_MS;
}

/** Map a driver/SDK result to a reply (reply.ok = result.ok, data = result.data). */
export function replyFromResult(result: unknown): CommandReply {
  if (!isPlainObject(result) || typeof result.ok !== 'boolean') {
    return fail('The device returned an invalid result', 'action.invalidResult');
  }
  const r = result as unknown as DeviceActionResult;
  if (r.ok) {
    const reply: CommandReply = { ok: true, data: r.data === undefined ? null : r.data };
    if (r.code) reply.code = r.code;
    return reply;
  }
  const reply: CommandReply = { ok: false, error: r.error || r.message || 'The action failed', code: r.code || 'action.failed' };
  if (r.data !== undefined) reply.data = r.data;
  return reply;
}

function noDriverError(deviceId: string): CommandError {
  if (deviceId.startsWith('import:')) return new CommandError('Imported sessions are read-only recordings', 'device.readOnly');
  if (deviceId === 'desktop') return new CommandError('The desktop entry has no device actions', 'device.noActions');
  if (deviceId.startsWith('net:')) {
    return new CommandError(
      'This device is only connected through the app SDK over the network; device actions need USB or a simulator',
      'device.networkOnly',
    );
  }
  return new CommandError(`No driver handles device ${deviceId} (it may have been disconnected)`, 'device.unknown');
}

interface MetricsWatch {
  driver: DeviceDriver;
  deviceId: string;
  target: { pid?: number; processName?: string };
  clients: Set<number>;
}

export interface CommandRouter {
  handle(command: unknown, client: CommandClient): Promise<CommandReply>;
  /** Stop metric polling that only this (now closed) UI connection asked for. */
  clientClosed(clientId: number): void;
  findDriver(deviceId: string): DeviceDriver | undefined;
}

export function createCommandRouter(deps: CommandDeps): CommandRouter {
  const watches = new Map<string, MetricsWatch>();

  function findDriver(deviceId: string): DeviceDriver | undefined {
    for (const d of deps.drivers()) {
      try {
        if (d.owns(deviceId)) return d;
      } catch (err) {
        deps.logger.warn(`driver ${d.id}: owns(${deviceId}) threw: ${errorMessage(err)}`);
      }
    }
    return undefined;
  }

  function setWatch(driver: DeviceDriver, deviceId: string, target: MetricsWatch['target'], enabled: boolean): void {
    try {
      driver.watchMetrics?.(deviceId, target, enabled);
    } catch (err) {
      deps.logger.warn(`driver ${driver.id}: watchMetrics failed: ${errorMessage(err)}`);
      if (enabled) throw err;
    }
  }

  async function deviceAction(cmd: Record<string, unknown>): Promise<CommandReply> {
    const deviceId = reqString(cmd.deviceId, 'deviceId');
    const action = reqString(cmd.action, 'action', 100);
    const params = optParams(cmd.params);
    const driver = findDriver(deviceId);
    if (!driver) throw noDriverError(deviceId);
    const result = await withTimeout(
      Promise.resolve().then(() => driver.runAction(deviceId, action as DeviceActionId, params)),
      actionTimeoutMs(action, params),
      `Device action ${action}`,
      'action.timeout',
    );
    return replyFromResult(result);
  }

  async function appAction(cmd: Record<string, unknown>): Promise<CommandReply> {
    const appId = reqString(cmd.appId, 'appId');
    const action = reqString(cmd.action, 'action', 200);
    const params = optParams(cmd.params);
    const app = deps.hub.getApp(appId);
    if (!app) throw new CommandError(`Unknown app session ${appId}`, 'app.unknown');
    if (!app.connected) throw new CommandError(`${app.app.name || app.app.id} is not connected`, 'app.disconnected');
    const result = await withTimeout(
      Promise.resolve().then(() => deps.sdk.sendCommand(appId, action, params)),
      APP_COMMAND_TIMEOUT_MS,
      `App command ${action}`,
      'app.timeout',
    );
    return replyFromResult(result);
  }

  async function settingsUpdate(cmd: Record<string, unknown>, client: CommandClient): Promise<CommandReply> {
    if (!isPlainObject(cmd.patch)) throw invalid('patch must be an object');
    const previousLan = deps.config.settings.allowLan;
    const result = deps.config.updateSettings(cmd.patch);
    if (result.adjusted.length > 0) {
      const details = result.adjusted.join('; ');
      client.notice({ level: 'info', message: `Some values were adjusted: ${details}`, code: 'settings.adjusted', params: { details } });
    }
    if (result.settings.allowLan !== previousLan) await deps.onLanChanged(result.settings.allowLan);
    return ok(result.settings);
  }

  function metricsWatch(cmd: Record<string, unknown>, client: CommandClient): CommandReply {
    const deviceId = reqString(cmd.deviceId, 'deviceId');
    if (typeof cmd.enabled !== 'boolean') throw invalid('enabled must be true or false');
    let pid: number | undefined;
    if (cmd.pid !== undefined && cmd.pid !== null) {
      if (typeof cmd.pid !== 'number' || !Number.isInteger(cmd.pid) || cmd.pid < 0) throw invalid('pid must be a positive integer');
      pid = cmd.pid;
    }
    const processName = optString(cmd.processName, 'processName', 500);
    if (pid === undefined && processName === undefined) throw invalid('pid or processName is required');
    const driver = findDriver(deviceId);
    if (!driver || typeof driver.watchMetrics !== 'function') {
      throw new CommandError('CPU/memory polling is not available for this device', 'metrics.unsupported');
    }
    const target: MetricsWatch['target'] = {};
    if (pid !== undefined) target.pid = pid;
    if (processName !== undefined) target.processName = processName;
    const key = `${deviceId}\u0000${pid ?? ''}\u0000${processName ?? ''}`;
    const existing = watches.get(key);
    if (cmd.enabled) {
      if (existing) existing.clients.add(client.id);
      else {
        setWatch(driver, deviceId, target, true);
        watches.set(key, { driver, deviceId, target, clients: new Set([client.id]) });
      }
    } else if (existing) {
      existing.clients.delete(client.id);
      if (existing.clients.size === 0) {
        watches.delete(key);
        setWatch(existing.driver, deviceId, target, false);
      }
    } else {
      setWatch(driver, deviceId, target, false);
    }
    return ok(null);
  }

  async function netReplay(cmd: Record<string, unknown>, client: CommandClient): Promise<CommandReply> {
    const id = reqString(cmd.id, 'id');
    let overrides: ReplayOverrides | undefined;
    if (cmd.overrides !== undefined && cmd.overrides !== null) {
      if (!isPlainObject(cmd.overrides)) throw invalid('overrides must be an object');
      const o = cmd.overrides;
      overrides = {};
      if (o.method !== undefined) overrides.method = reqString(o.method, 'overrides.method', 32);
      if (o.url !== undefined) overrides.url = reqString(o.url, 'overrides.url', 65_536);
      if (o.headers !== undefined) {
        if (!Array.isArray(o.headers) || o.headers.some((h) => !Array.isArray(h) || h.length < 2)) {
          throw invalid('overrides.headers must be a list of [name, value] pairs');
        }
        overrides.headers = (o.headers as unknown[][]).map((h) => [String(h[0]), String(h[1])]);
      }
      if (o.body !== undefined && o.body !== null) {
        if (typeof o.body !== 'string') throw invalid('overrides.body must be a string');
        overrides.body = o.body;
      }
      if (o.bodyEncoding === 'base64' || o.bodyEncoding === 'utf8') overrides.bodyEncoding = o.bodyEncoding;
    }
    const result = await replayRequest(
      {
        hub: deps.hub,
        maxBodyBytes: deps.config.settings.maxBodyBytes,
        timeoutMs: deps.replayTimeoutMs,
        fetchImpl: deps.fetchImpl,
      },
      id,
      overrides,
    );
    for (const w of result.warnings) client.notice({ level: 'warn', message: w.message, code: w.code });
    return ok(result.entry);
  }

  async function handle(command: unknown, client: CommandClient): Promise<CommandReply> {
    if (!isPlainObject(command) || typeof command.name !== 'string') return fail('Invalid command', 'command.invalid');
    const cmd = command;
    const name = command.name;
    try {
      switch (name) {
        case 'clear': {
          const target = cmd.target as ClearTarget;
          if (!CLEAR_TARGETS.includes(target)) throw invalid(`target must be one of ${CLEAR_TARGETS.join(', ')}`);
          const scope: { deviceId?: string; appId?: string; bundleId?: string } = {};
          const deviceId = optString(cmd.deviceId, 'deviceId');
          const appId = optString(cmd.appId, 'appId');
          const bundleId = optString(cmd.bundleId, 'bundleId');
          if (deviceId) scope.deviceId = deviceId;
          if (appId) scope.appId = appId;
          if (bundleId) scope.bundleId = bundleId;
          deps.hub.clear(target, scope);
          return ok(null);
        }
        case 'marker.add': {
          const label = optString(cmd.label, 'label', 2_000);
          const deviceId = optString(cmd.deviceId, 'deviceId');
          return ok(deps.hub.addMarker(label, deviceId));
        }
        case 'device.action':
          return await deviceAction(cmd);
        case 'app.action':
          return await appAction(cmd);
        case 'mocks.set':
          return ok(deps.config.setMocks(cmd.rules));
        case 'settings.update':
          return await settingsUpdate(cmd, client);
        case 'vm.attach': {
          const vm = deps.vm;
          if (!vm) throw new CommandError('The Flutter VM Service module is not available', 'vm.unavailable');
          const input = reqString(cmd.input, 'input', 1_000_000);
          const deviceId = optString(cmd.deviceId, 'deviceId');
          const result = await withTimeout(
            Promise.resolve().then(() => vm.attach(input, deviceId ? { deviceId } : undefined)),
            VM_ATTACH_TIMEOUT_MS,
            'Attaching to the Dart VM Service',
            'vm.timeout',
          );
          return ok({ appId: result.appId });
        }
        case 'vm.detach': {
          const vm = deps.vm;
          if (!vm) throw new CommandError('The Flutter VM Service module is not available', 'vm.unavailable');
          await vm.detach(reqString(cmd.appId, 'appId'));
          return ok(null);
        }
        case 'metrics.watch':
          return metricsWatch(cmd, client);
        case 'net.replay':
          return await netReplay(cmd, client);
        case 'demo.set': {
          if (typeof cmd.enabled !== 'boolean') throw invalid('enabled must be true or false');
          return ok({ enabled: await deps.setDemo(cmd.enabled) });
        }
        case 'doctor.run':
          return ok(await deps.runDoctor());
        default:
          return fail(`Unknown command "${name}"`, 'command.unknown');
      }
    } catch (err) {
      if (err instanceof CommandError || err instanceof ReplayError || err instanceof ConfigValidationError) {
        return fail(err.message, err.code);
      }
      deps.logger.error(`command ${name} failed: ${errorMessage(err)}`);
      // Modules may throw errors carrying an i18n code (e.g. 'vm.noServiceUrl'); keep it for the UI.
      const code = (err as { code?: unknown } | undefined)?.code;
      return fail(errorMessage(err), typeof code === 'string' && /^[a-z][\w-]*\.[\w.-]+$/.test(code) ? code : 'command.failed');
    }
  }

  function clientClosed(clientId: number): void {
    for (const [key, w] of watches) {
      if (!w.clients.delete(clientId) || w.clients.size > 0) continue;
      watches.delete(key);
      try {
        w.driver.watchMetrics?.(w.deviceId, w.target, false);
      } catch (err) {
        deps.logger.warn(`driver ${w.driver.id}: watchMetrics(off) failed: ${errorMessage(err)}`);
      }
    }
  }

  return { handle, clientClosed, findDriver };
}
