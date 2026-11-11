/**
 * Automatic runs: flows with automation on start by themselves when their "When something happens" trigger
 * matches — a crash, a log line, a failing or matching request, an app or a device connecting. Only while
 * Dürbün is open (there is no background service). A crash loop must not turn into a run storm, and a flow
 * must not keep starting itself (its own steps restart the app, log the line it waits for):
 *  - events are ignored while a run of the flow goes;
 *  - each trigger fires at most once per `throttleMs` (default 30 s), and a flow starts again at the earliest
 *    `throttleMs` after its last automatic run ended;
 *  - after LOOP_RUNS automatic runs in a row that each started soon (within 2 × throttleMs) after the previous
 *    one ended, the flow's automation is switched off, with a notice;
 *  - at most MAX_AUTOMATIC_RUNS automatic runs go at the same time.
 */
import {
  statusMatches,
  urlMatches,
  type AppSession,
  type DeviceInfo,
  type FlowDoc,
  type FlowNode,
  type LogEntry,
  type LogLevel,
  type NetworkEntry,
  type UiNotice,
} from '@durbun/protocol';
import type { Hub, Logger } from '../types';
import { FlowRunError, MAX_AUTOMATIC_RUNS, type FlowEngine } from './engine';
import type { FlowStore } from './store';
import { shortText } from './util';

export const DEFAULT_THROTTLE_MS = 30_000;
/** Automatic runs in a row, each right after the previous one, that switch the flow's automation off. */
export const LOOP_RUNS = 5;
const LEVELS: LogLevel[] = ['verbose', 'debug', 'info', 'warn', 'error', 'fatal'];

export type TriggerEvent =
  | { event: 'crash' | 'logMatch'; log: LogEntry; appId?: string }
  | { event: 'networkError' | 'networkMatch'; request: NetworkEntry; appId?: string }
  | { event: 'appConnected'; app: AppSession }
  | { event: 'deviceConnected'; device: DeviceInfo };

export interface TriggerDeps {
  hub: Hub;
  /** `save` switches a looping flow's automation off; `onChange` refreshes the list of automated flows. */
  flows: Pick<FlowStore, 'list'> & Partial<Pick<FlowStore, 'save' | 'onChange'>>;
  /** `onRunEnded` measures the throttle from the end of the last automatic run. */
  engine: Pick<FlowEngine, 'start' | 'runningCount'> & Partial<Pick<FlowEngine, 'onRunEnded'>>;
  logger: Logger;
  notice(n: UiNotice): void;
  now(): number;
}

function crashPackage(e: LogEntry): string | undefined {
  const d = e.data as { package?: unknown; bundleId?: unknown } | null | undefined;
  const v = d && typeof d === 'object' ? (d.package ?? d.bundleId) : undefined;
  return typeof v === 'string' && v ? v.split(':')[0] : undefined;
}

/** Compiled trigger patterns (a log storm must not compile the same regex per line); undefined = invalid. */
const regexCache = new Map<string, RegExp | undefined>();
function triggerRegex(text: string): RegExp | undefined {
  if (regexCache.has(text)) return regexCache.get(text);
  let re: RegExp | undefined;
  try {
    re = new RegExp(text);
  } catch {
    re = undefined;
  }
  if (regexCache.size >= 500) regexCache.clear();
  regexCache.set(text, re);
  return re;
}

/**
 * Does a trigger.event node match the event? A trigger without an app of its own watches the flow's app
 * (`flowAppId`, the flow's target), except "a device connects", which has no app.
 */
export function triggerMatches(node: FlowNode, ev: TriggerEvent, flowAppId?: string): boolean {
  const p = node.params ?? {};
  if ((p.event ?? 'crash') !== ev.event) return false;
  const ownApp = typeof p.appId === 'string' ? p.appId.trim() : '';
  const wantApp = ownApp || (ev.event !== 'deviceConnected' ? (flowAppId?.trim() ?? '') : '');
  const appOf = (): string | undefined => ('app' in ev ? ev.app.app.id : 'appId' in ev ? ev.appId : undefined);
  if (wantApp && !wantApp.includes('{{') && appOf() !== wantApp) return false;
  switch (ev.event) {
    case 'crash':
      return true;
    case 'logMatch': {
      const level = LEVELS.includes(p.level as LogLevel) ? (p.level as LogLevel) : 'verbose';
      if (LEVELS.indexOf(ev.log.level) < LEVELS.indexOf(level)) return false;
      const text = typeof p.text === 'string' ? p.text : '';
      if (!text) return true;
      if (p.regex === true) return triggerRegex(text)?.test(ev.log.message) ?? false;
      return ev.log.message.toLowerCase().includes(text.toLowerCase());
    }
    case 'networkError':
    case 'networkMatch': {
      const r = ev.request;
      const url = typeof p.url === 'string' ? p.url : '';
      if (url && !urlMatches(r.url, url, typeof p.match === 'string' ? p.match : 'contains')) return false;
      if (ev.event === 'networkMatch') {
        const method = typeof p.method === 'string' ? p.method : '*';
        if (method !== '*' && r.method.toUpperCase() !== method.toUpperCase()) return false;
        const status = typeof p.status === 'string' ? p.status.trim() : '';
        if (status && !statusMatches(r.status, status)) return false;
      }
      return true;
    }
    default:
      return true;
  }
}

/** What the run's templates read as {{trigger.…}} and the one-line description of the run. */
export function triggerData(ev: TriggerEvent): { data: Record<string, unknown>; detail: string; deviceId?: string; appId?: string } {
  switch (ev.event) {
    case 'crash':
    case 'logMatch': {
      const l = ev.log;
      return {
        data: { event: ev.event, deviceId: l.deviceId, appId: ev.appId ?? '', message: l.message, log: { message: l.message, level: l.level, tag: l.tag, ts: l.ts, data: l.data } },
        detail: shortText(l.message, 200),
        deviceId: l.deviceId,
        appId: ev.appId,
      };
    }
    case 'networkError':
    case 'networkMatch': {
      const r = ev.request;
      return {
        data: {
          event: ev.event,
          deviceId: r.deviceId,
          appId: ev.appId ?? '',
          message: `${r.method} ${r.url} → ${r.state === 'failed' ? (r.error ?? 'failed') : r.status}`,
          request: { id: r.id, method: r.method, url: r.url, status: r.status, error: r.error, durationMs: r.duration },
        },
        detail: `${r.method} ${shortText(r.url, 140)} → ${r.state === 'failed' ? 'failed' : r.status}`,
        deviceId: r.deviceId,
        appId: ev.appId,
      };
    }
    case 'appConnected':
      return {
        data: { event: ev.event, deviceId: ev.app.deviceId, appId: ev.app.app.id, message: `${ev.app.app.name} connected`, app: { name: ev.app.app.name, id: ev.app.app.id, version: ev.app.app.version } },
        detail: `${ev.app.app.name} (${ev.app.app.id})`,
        deviceId: ev.app.deviceId,
        appId: ev.app.app.id,
      };
    case 'deviceConnected':
      return {
        data: { event: ev.event, deviceId: ev.device.id, appId: '', message: `${ev.device.name} connected`, device: { id: ev.device.id, name: ev.device.name, platform: ev.device.platform } },
        detail: ev.device.name,
        deviceId: ev.device.id,
      };
  }
}

const ignoredDevice = (id: string) => id === 'desktop' || id.startsWith('import:');

export class FlowTriggers {
  private readonly lastFired = new Map<string, number>();
  /** When each flow's last automatic run ended (the trigger clock). */
  private readonly lastEnded = new Map<string, number>();
  /** Automatic runs in a row that started soon after the previous one ended. */
  private readonly streak = new Map<string, number>();
  /** Flows whose automation was switched off here and not yet saved so. */
  private readonly switchedOff = new Set<string>();
  private automatedCache: { flow: FlowDoc; node: FlowNode }[] | undefined;
  private readonly firedRequests = new Set<string>();
  private readonly onlineDevices = new Set<string>();
  private readonly connectedApps = new Set<string>();
  private readonly unsubscribers: (() => void)[] = [];

  constructor(private readonly deps: TriggerDeps) {
    for (const d of deps.hub.getDevices()) if (d.state === 'online') this.onlineDevices.add(d.id);
    for (const a of deps.hub.getApps()) if (a.connected) this.connectedApps.add(a.id);
    if (deps.engine.onRunEnded) {
      this.unsubscribers.push(
        deps.engine.onRunEnded((run) => {
          if (run.trigger.kind === 'event') this.lastEnded.set(run.flowId, this.deps.now());
        }),
      );
    }
    if (deps.flows.onChange) {
      this.unsubscribers.push(
        deps.flows.onChange(() => {
          this.automatedCache = undefined;
          regexCache.clear();
          for (const id of this.switchedOff) if (!this.deps.flows.list().some((f) => f.id === id && f.automation?.enabled)) this.switchedOff.delete(id);
        }),
      );
    }
    this.unsubscribers.push(
      deps.hub.onLogs((entries) => {
        if (this.automated().length === 0) return;
        // A synchronous tap inside the hub's append: look at the lines after it returns.
        const copy = entries.slice();
        queueMicrotask(() => this.onLogs(copy));
      }),
      deps.hub.subscribe((change) => {
        if (change.network.length) this.onNetwork(change.network);
        if (change.apps.length) this.onApps(change.apps);
        if (change.devices.length) this.onDevices(change.devices);
        for (const id of change.removedDevices) this.onlineDevices.delete(id);
      }),
    );
  }

  dispose(): void {
    for (const u of this.unsubscribers) u();
  }

  private automated(): { flow: FlowDoc; node: FlowNode }[] {
    if (this.automatedCache) return this.automatedCache;
    const out: { flow: FlowDoc; node: FlowNode }[] = [];
    for (const flow of this.deps.flows.list()) {
      if (!flow.automation?.enabled) continue;
      for (const node of flow.nodes) if (node.type === 'trigger.event' && !node.disabled) out.push({ flow, node });
    }
    // Without change events the list is read every time.
    if (this.deps.flows.onChange) this.automatedCache = out;
    return out;
  }

  private appIdOfLog(e: LogEntry): string | undefined {
    if (e.appId) return this.deps.hub.getApp(e.appId)?.app.id;
    return crashPackage(e) ?? (e.process && /\./.test(e.process) ? e.process.split(':')[0] : undefined);
  }

  private onLogs(entries: LogEntry[]): void {
    for (const e of entries) {
      if (ignoredDevice(e.deviceId) || e.kind === 'marker' || e.kind === 'network' || e.origin === 'durbun') continue;
      const appId = this.appIdOfLog(e);
      if (e.kind === 'crash' || e.kind === 'anr') this.fire({ event: 'crash', log: e, appId });
      this.fire({ event: 'logMatch', log: e, appId });
    }
  }

  private onNetwork(entries: NetworkEntry[]): void {
    for (const r of entries) {
      if (ignoredDevice(r.deviceId) || r.state === 'pending' || this.firedRequests.has(r.id)) continue;
      this.firedRequests.add(r.id);
      if (this.firedRequests.size > 20_000) this.firedRequests.clear();
      const appId = r.appId ? this.deps.hub.getApp(r.appId)?.app.id : undefined;
      if (r.state === 'failed' || (r.status ?? 0) >= 500) this.fire({ event: 'networkError', request: r, appId });
      this.fire({ event: 'networkMatch', request: r, appId });
    }
  }

  private onApps(apps: AppSession[]): void {
    for (const a of apps) {
      if (!a.connected) {
        this.connectedApps.delete(a.id);
        continue;
      }
      if (this.connectedApps.has(a.id) || ignoredDevice(a.deviceId) || a.transport === 'import') continue;
      this.connectedApps.add(a.id);
      this.fire({ event: 'appConnected', app: a });
    }
  }

  private onDevices(devices: DeviceInfo[]): void {
    for (const d of devices) {
      if (d.state !== 'online') {
        this.onlineDevices.delete(d.id);
        continue;
      }
      if (this.onlineDevices.has(d.id) || ignoredDevice(d.id) || d.id.startsWith('net:')) continue;
      this.onlineDevices.add(d.id);
      this.fire({ event: 'deviceConnected', device: d });
    }
  }

  /** Start every automated flow whose trigger matches (tests call it directly). */
  fire(ev: TriggerEvent): void {
    for (const { flow, node } of this.automated()) {
      if (this.switchedOff.has(flow.id)) continue;
      if (!triggerMatches(node, ev, flow.target?.appId)) continue;
      const key = `${flow.id}\u0000${node.id}`;
      const now = this.deps.now();
      const throttle = flow.automation?.throttleMs ?? DEFAULT_THROTTLE_MS;
      if (now - (this.lastFired.get(key) ?? -Infinity) < throttle) continue;
      // What the flow's own run makes happen (it restarts the app, logs the line) does not start it again.
      if (this.deps.engine.runningCount(flow.id) > 0) continue;
      const lastEnd = this.lastEnded.get(flow.id);
      if (lastEnd !== undefined && now - lastEnd < throttle) continue;
      if (this.deps.engine.runningCount(undefined, true) >= MAX_AUTOMATIC_RUNS) {
        this.deps.logger.info(`automation: ${flow.id} not started, ${MAX_AUTOMATIC_RUNS} automatic runs are going`);
        continue;
      }
      this.lastFired.set(key, now);
      const soonAfterLast = lastEnd !== undefined && now - lastEnd < 2 * throttle;
      const t = triggerData(ev);
      const target: { deviceId?: string; appId?: string } = {};
      if (t.deviceId && !ignoredDevice(t.deviceId)) target.deviceId = t.deviceId;
      const appId = flow.target?.appId || t.appId;
      if (appId) target.appId = appId;
      this.deps.engine
        .start(flow.id, { target }, { automatic: true, trigger: { kind: 'event', event: ev.event, detail: t.detail }, triggerNodeId: node.id, triggerData: t.data })
        .then((run) => {
          this.deps.logger.info(`automation: started ${flow.id} (${run.id}) on ${ev.event}`);
          const n = soonAfterLast ? (this.streak.get(flow.id) ?? 1) + 1 : 1;
          this.streak.set(flow.id, n);
          if (n >= LOOP_RUNS) this.switchOff(flow, n);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.deps.logger.warn(`automation: ${flow.id} could not start: ${message}`);
          this.deps.notice({
            level: 'warn',
            message: `The automatic flow "${flow.name}" could not start: ${message}`,
            code: 'flow.automation.failed',
            params: { flow: flow.name, error: message, ...(err instanceof FlowRunError ? { reason: err.code } : {}) },
          });
        });
    }
  }

  /** The flow keeps starting right after it ends: its automation goes off (saved), the user is told. */
  private switchOff(flow: FlowDoc, count: number): void {
    this.switchedOff.add(flow.id);
    this.streak.delete(flow.id);
    this.automatedCache = undefined;
    this.deps.logger.warn(`automation: ${flow.id} started ${count} times in a row right after its previous run; automation switched off`);
    this.deps.notice({
      level: 'warn',
      message: `Automation for "${flow.name}" was switched off: it started ${count} times in a row right after its previous run`,
      code: 'flow.automation.loop',
      params: { flow: flow.name, count },
    });
    const current = this.deps.flows.list().find((f) => f.id === flow.id);
    if (!current?.automation?.enabled || !this.deps.flows.save) return;
    this.deps.flows.save({ ...current, automation: { ...current.automation, enabled: false } }, { id: current.id }).catch((err: unknown) => {
      this.deps.logger.warn(`automation: could not switch ${flow.id} off: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
