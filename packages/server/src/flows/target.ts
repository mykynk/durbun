/**
 * Which device and app a run works with, and whether a node can run there. Shared by the preflight (before
 * the run, to list what will be skipped) and the engine (each step checks again: devices come and go).
 */
import {
  DEVICE_ACTION_SUPPORT,
  deviceSupportsAction,
  flowNodeSpec,
  type AppSession,
  type DeviceInfo,
  type FlowDoc,
  type FlowNode,
  type FlowPreflightIssue,
  type FlowRunTarget,
  type SdkCapability,
} from '@durbun/protocol';
import type { Hub } from '../types';

export interface ResolvedTarget {
  device?: DeviceInfo;
  appId?: string;
  info: FlowRunTarget;
}

/** Devices a flow can drive: real, connected and not read-only. */
export function usableDevice(d: DeviceInfo): boolean {
  if (d.id === 'desktop' || d.id.startsWith('import:')) return false;
  return d.state === 'online';
}

/** Does this node work with the device (`needs.device` / `needs.deviceAction`)? */
export function needsDevice(node: FlowNode): boolean {
  const n = flowNodeSpec(node.type)?.needs;
  return !!(n?.device || n?.deviceAction || n?.sdk === 'network' || n?.sdk === 'events');
}

/** Does the flow (or a flow it calls) have a step that needs a device? */
export function flowNeedsDevice(flow: FlowDoc, getFlow: (id: string) => FlowDoc | undefined, seen = new Set<string>()): boolean {
  if (seen.has(flow.id)) return false;
  seen.add(flow.id);
  for (const n of flow.nodes) {
    if (n.disabled) continue;
    if (needsDevice(n)) return true;
    if (n.type === 'flow.call' && typeof n.params?.flowId === 'string') {
      const sub = getFlow(n.params.flowId);
      if (sub && flowNeedsDevice(sub, getFlow, seen)) return true;
    }
  }
  return false;
}

/** Connected SDK sessions of the app on the device. */
export function appSessions(hub: Pick<Hub, 'getApps'>, deviceId: string | undefined, appId: string | undefined): AppSession[] {
  return hub.getApps().filter((a) => a.connected && (!deviceId || a.deviceId === deviceId) && (!appId || a.app.id === appId));
}

export function sdkSession(hub: Pick<Hub, 'getApps'>, deviceId: string | undefined, appId: string | undefined, cap: SdkCapability): AppSession | undefined {
  return appSessions(hub, deviceId, appId)
    .filter((a) => a.capabilities.includes(cap))
    .sort((a, b) => b.connectedAt - a.connectedAt)[0];
}

function describe(device: DeviceInfo | undefined, appId: string | undefined, hub: Pick<Hub, 'getApps' | 'getDeviceApps'>): FlowRunTarget {
  const info: FlowRunTarget = {};
  if (device) {
    info.deviceId = device.id;
    info.deviceName = device.name;
    info.platform = device.platform;
    info.kind = device.kind;
    if (device.osVersion) info.osVersion = device.osVersion;
  }
  if (appId) {
    info.appId = appId;
    const session = hub
      .getApps()
      .filter((a) => a.app.id === appId && (!device || a.deviceId === device.id))
      .sort((a, b) => b.connectedAt - a.connectedAt)[0];
    const installed = device ? hub.getDeviceApps().find((d) => d.deviceId === device.id && d.id === appId) : undefined;
    const name = session?.app.name || installed?.name;
    const version = session?.app.version || installed?.version;
    if (name) info.appName = name;
    if (version) info.appVersion = version;
  }
  return info;
}

/**
 * Pick the device and app. An explicit device must exist; without one, a flow that needs a device gets the
 * only usable device, or — with several — the one that has the app (then the most recently seen), with an
 * info line saying which was chosen.
 */
export function resolveTarget(
  hub: Pick<Hub, 'getDevices' | 'getDevice' | 'getApps' | 'getDeviceApps'>,
  flow: FlowDoc,
  wanted: { deviceId?: string; appId?: string } | undefined,
  needsDeviceNow: boolean,
): { target: ResolvedTarget; issues: FlowPreflightIssue[] } {
  const issues: FlowPreflightIssue[] = [];
  let appId = wanted?.appId?.trim() || flow.target?.appId?.trim() || undefined;
  let device: DeviceInfo | undefined;
  if (wanted?.deviceId) {
    device = hub.getDevice(wanted.deviceId);
    if (!device) {
      // A flow without device steps still runs (its device was only the run's context: trigger data, the app).
      issues.push({
        level: needsDeviceNow ? 'error' : 'warn',
        code: 'preflight.device.gone',
        message: `The device ${wanted.deviceId} is not connected any more`,
        params: { device: wanted.deviceId },
      });
    } else if (!usableDevice(device)) {
      issues.push({
        level: needsDeviceNow ? 'error' : 'warn',
        code: 'preflight.device.offline',
        message: `${device.name} is not ready (${device.state})`,
        params: { device: device.name, state: device.state },
      });
    }
  } else if (needsDeviceNow) {
    const platform = flow.target?.platform && flow.target.platform !== 'any' ? flow.target.platform : undefined;
    const candidates = hub.getDevices().filter((d) => usableDevice(d) && (!platform || d.platform === platform));
    const hasApp = (d: DeviceInfo) =>
      !!appId && (hub.getDeviceApps().some((a) => a.deviceId === d.id && a.id === appId) || hub.getApps().some((a) => a.deviceId === d.id && a.app.id === appId));
    const ranked = [...candidates].sort((a, b) => Number(hasApp(b)) - Number(hasApp(a)) || b.lastSeen - a.lastSeen);
    device = ranked[0];
    if (!device) {
      issues.push({
        level: 'error',
        code: platform ? 'preflight.device.nonePlatform' : 'preflight.device.none',
        message: platform ? `No ${platform} device is connected; this flow has device steps` : 'No device is connected; this flow has device steps',
        params: platform ? { platform } : {},
      });
    } else if (candidates.length > 1) {
      issues.push({ level: 'info', code: 'preflight.device.auto', message: `Runs on ${device.name} (choose another device in the run settings)`, params: { device: device.name } });
    }
  }
  if (!appId && device) {
    // A single SDK app on the device is what the tester means.
    const sessions = appSessions(hub, device.id, undefined);
    const ids = [...new Set(sessions.map((s) => s.app.id))];
    if (ids.length === 1) appId = ids[0];
  }
  if (device && appId && usableDevice(device)) {
    const known = hub.getDeviceApps().some((a) => a.deviceId === device!.id && a.id === appId) || hub.getApps().some((a) => a.deviceId === device!.id && a.app.id === appId);
    const listsApps = hub.getDeviceApps().some((a) => a.deviceId === device!.id);
    if (!known && listsApps) {
      issues.push({ level: 'warn', code: 'preflight.app.notInstalled', message: `${appId} was not seen on ${device.name}`, params: { app: appId, device: device.name } });
    }
  }
  return { target: { device, appId, info: describe(device, appId, hub) }, issues };
}

/** Why a node cannot run on this target (undefined = it can). SDK needs are checked when the step starts. */
export function unsupportedReason(
  node: FlowNode,
  target: ResolvedTarget,
  slackConfigured: boolean,
): FlowPreflightIssue | undefined {
  const spec = flowNodeSpec(node.type);
  const needs = spec?.needs;
  if (!needs) return undefined;
  const device = target.device;
  if (needs.slack && !slackConfigured) {
    return { level: 'warn', code: 'preflight.slack.notConfigured', message: 'Slack is not connected (Settings → Slack)', nodeId: node.id };
  }
  if (needs.device || needs.deviceAction) {
    if (!device || !usableDevice(device)) {
      return { level: 'warn', code: 'preflight.device.missing', message: 'This step needs a connected device', nodeId: node.id };
    }
  }
  if (needs.deviceAction && device) {
    const action = needs.deviceAction;
    if (!device.actions.includes(action)) {
      const s = DEVICE_ACTION_SUPPORT[action];
      const where =
        device.platform === 'android' && s?.android === 'emulator'
          ? 'emulator'
          : device.platform === 'ios' && device.kind === 'physical' && s?.iosSimulator
            ? 'simulator'
            : deviceSupportsAction(action, device.platform, device.kind)
              ? 'tool'
              : 'platform';
      const message =
        where === 'emulator'
          ? `${spec!.title} works only on an Android emulator`
          : where === 'simulator'
            ? `${spec!.title} works only on the iOS simulator`
            : where === 'tool'
              ? `${spec!.title} is not available on ${device.name} right now (a tool is missing)`
              : `${spec!.title} is not supported on ${device.platform === 'ios' ? 'iOS' : device.platform === 'android' ? 'Android' : device.platform}`;
      return { level: 'warn', code: `preflight.action.${where}`, message, nodeId: node.id, params: { step: spec!.title, device: device.name, action } };
    }
  }
  return undefined;
}
