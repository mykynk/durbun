import type { AppSession, DeviceApp, DeviceInfo, NetworkDetail, NetworkEntry } from '@durbun/protocol';
import { translate, type Lang } from '../../i18n';
import { buildBadgeOf } from '../../data/explain';
import { buildBadgeLabel } from '../../sources/text';
import { safeFileStem } from './model/http';
import type { ShareInput, ShareLabels } from './model/shareReport';
import './i18n';

/** Report labels in [lang] (the report follows the UI language). */
export function shareLabels(lang: Lang): ShareLabels {
  const r = (key: string, params?: Record<string, string | number>) => translate(lang, `network.share.report.${key}`, params);
  return {
    pending: r('pending'),
    failed: r('failed'),
    cancelled: r('cancelled'),
    time: r('time'),
    app: r('app'),
    device: r('device'),
    client: r('client'),
    graphql: r('graphql'),
    trace: r('trace'),
    mocked: (rule) => r('mocked', rule ? { rule } : undefined),
    error: r('error'),
    requestHeaders: r('requestHeaders'),
    responseHeaders: r('responseHeaders'),
    requestBody: r('requestBody'),
    responseBody: r('responseBody'),
    notCaptured: r('notCaptured'),
    binary: r('binary'),
    captured: (captured, total) => r('captured', { captured, total }),
    more: (count) => r('more', { count }),
    curlNoBody: r('curlNoBody'),
    masked: r('masked'),
  };
}

/** Keys of `network.share.report.*` (the i18n test checks both languages). */
export const SHARE_REPORT_KEYS = [
  'pending',
  'failed',
  'cancelled',
  'time',
  'app',
  'device',
  'client',
  'graphql',
  'trace',
  'mocked',
  'error',
  'requestHeaders',
  'responseHeaders',
  'requestBody',
  'responseBody',
  'notCaptured',
  'binary',
  'captured',
  'more',
  'curlNoBody',
  'masked',
] as const;

function platformName(d: DeviceInfo): string {
  switch (d.platform) {
    case 'android':
      return 'Android';
    case 'ios':
      return 'iOS';
    default:
      return '';
  }
}

/**
 * "Shop 2.4.1 (812) · com.example.shop · TestFlight": name, version (build), bundle id and where the build came
 * from, so "which build?" is answered in the report. The SDK session says what the app reports about itself; the
 * device's report (`DeviceApp`) fills the gaps and is the only source for SDK-less builds (store, Firebase, an APK).
 * `install`: the localized build / install source label (`buildBadgeLabel`), when known.
 */
export function shareAppLabel(app: AppSession | undefined, deviceApp?: DeviceApp, install?: string): string | undefined {
  const id = app?.app.id ?? deviceApp?.id;
  if (!id) return undefined;
  const name = app?.app.name || deviceApp?.name || id;
  const version = app?.app.version || deviceApp?.version;
  const build = app?.app.build || deviceApp?.build;
  const head = `${name}${version ? ` ${version}` : ''}${build && build !== version ? ` (${build})` : ''}`;
  return [head, name !== id ? id : undefined, install].filter(Boolean).join(' · ');
}

/** "Play", "TestFlight / ad-hoc", "Firebase", "APK", "Debug"…: where the build came from, in the UI language. */
export function shareInstallLabel(deviceApp: DeviceApp | undefined, session: AppSession | undefined, device: DeviceInfo | undefined): string | undefined {
  const badge = buildBadgeOf({ deviceApp, sessions: session ? [session] : [], device });
  return badge ? buildBadgeLabel(badge, deviceApp?.install.installer) : undefined;
}

/** "iPhone 16 Pro (iPhone17,1) · iOS 18.2": the name reads better than a model identifier. None for the desktop. */
export function shareDeviceLabel(device: DeviceInfo | undefined): string | undefined {
  if (!device || device.id === 'desktop') return undefined;
  const os = [platformName(device), device.osVersion].filter(Boolean).join(' ');
  return [device.model && device.model !== device.name ? `${device.name} (${device.model})` : device.name, os].filter(Boolean).join(' · ');
}

/** The report input for [entry]; [detail] carries the bodies when they were loaded. */
export function shareInputFor(
  entry: NetworkEntry,
  detail: NetworkDetail | null | undefined,
  context: { app?: AppSession; device?: DeviceInfo; rule?: string; deviceApp?: DeviceApp; install?: string } = {},
): ShareInput {
  const { app, device } = context;
  return {
    method: entry.method,
    url: entry.url,
    state: entry.state,
    status: entry.status,
    statusText: entry.statusText,
    error: entry.error,
    startTs: entry.startTs,
    duration: entry.duration,
    source: entry.source,
    graphql: entry.graphql ? [entry.graphql.operationType ?? 'query', entry.graphql.operationName].filter(Boolean).join(' ') : undefined,
    app: shareAppLabel(app, context.deviceApp, context.install),
    device: entry.deviceId !== 'desktop' ? shareDeviceLabel(device) : undefined,
    mocked: entry.mocked,
    mockRule: context.rule ?? entry.mockRuleId,
    requestHeaders: entry.requestHeaders,
    responseHeaders: entry.responseHeaders,
    requestContentType: entry.requestContentType,
    responseContentType: entry.responseContentType,
    requestBody: detail?.requestBody ?? null,
    responseBody: detail?.responseBody ?? null,
    requestBodyMissing: entry.hasRequestBody && !detail?.requestBody,
    responseBodyMissing: entry.hasResponseBody && !detail?.responseBody,
  };
}

export function shareFileName(entry: NetworkEntry): string {
  return `durbun-${safeFileStem(entry.host, entry.path)}.md`;
}
