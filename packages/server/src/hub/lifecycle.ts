/**
 * Builders for Dürbün-generated system lines (SPEC §4): an i18n `code` + `params` for the UI and an
 * English `message` fallback.
 */
import type { AppSession, DeviceInfo } from '@durbun/protocol';
import type { SystemLogInput } from '../types';

/** OS label before the version ("Android 15", "iOS 18.2"); other devices report their own ("macOS 27.2"). */
const PLATFORM_LABEL: Record<DeviceInfo['platform'], string> = { android: 'Android', ios: 'iOS', other: '' };

export function deviceConnectedLine(device: DeviceInfo): SystemLogInput {
  const os = device.osVersion ? ` ${PLATFORM_LABEL[device.platform]} ${device.osVersion}` : '';
  return {
    message: `Device connected: ${device.name}${os ? ` (${os.trim()})` : ''}`,
    level: 'info',
    kind: 'lifecycle',
    code: 'device.connected',
    params: {
      device: device.name,
      deviceId: device.id,
      platform: device.platform,
      kind: device.kind,
      connection: device.connection,
      osVersion: device.osVersion ?? '',
    },
  };
}

export function deviceDisconnectedLine(device: DeviceInfo, detail?: string): SystemLogInput {
  return {
    message: `Device disconnected: ${device.name}${detail ? ` — ${detail}` : ''}`,
    level: 'warn',
    kind: 'lifecycle',
    code: 'device.disconnected',
    params: { device: device.name, deviceId: device.id, state: device.state, detail: detail ?? '' },
  };
}

function appParams(app: AppSession, deviceName: string) {
  return {
    app: app.app.name,
    bundleId: app.app.id,
    version: app.app.version ?? '',
    sdk: app.sdk.platform,
    transport: app.transport,
    device: deviceName,
  };
}

export function appConnectedLine(app: AppSession, deviceName: string): SystemLogInput {
  const version = app.app.version ? ` ${app.app.version}` : '';
  return {
    message: `${app.app.name}${version} connected (${app.sdk.platform} SDK via ${app.transport})`,
    level: 'info',
    kind: 'lifecycle',
    code: 'app.connected',
    params: appParams(app, deviceName),
    appId: app.id,
  };
}

export function appReconnectedLine(app: AppSession, deviceName: string): SystemLogInput {
  return {
    message: `${app.app.name} reconnected (${app.transport})`,
    level: 'info',
    kind: 'lifecycle',
    code: 'app.reconnected',
    params: appParams(app, deviceName),
    appId: app.id,
  };
}

export function appDisconnectedLine(app: AppSession, deviceName: string, failedRequests: number): SystemLogInput {
  const pending = failedRequests > 0 ? ` (${failedRequests} pending request${failedRequests === 1 ? '' : 's'} failed)` : '';
  return {
    message: `${app.app.name} disconnected${pending}`,
    level: 'info',
    kind: 'lifecycle',
    code: 'app.disconnected',
    params: { ...appParams(app, deviceName), failedRequests },
    appId: app.id,
  };
}

export function processLine(event: 'started' | 'died', name: string, pid: number, appId?: string): SystemLogInput {
  const input: SystemLogInput = {
    message: event === 'started' ? `Process started: ${name} (pid ${pid})` : `Process died: ${name} (pid ${pid})`,
    level: 'info',
    kind: 'lifecycle',
    code: event === 'started' ? 'process.started' : 'process.died',
    params: { process: name, pid },
  };
  if (appId) input.appId = appId;
  return input;
}

export function markerLine(label: string | undefined, n: number): SystemLogInput {
  const text = label?.trim();
  return {
    message: text ? text : `Marker ${n}`,
    level: 'info',
    kind: 'marker',
    code: 'marker',
    params: { label: text ?? '', n },
  };
}
