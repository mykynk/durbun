import type { AppSession, DeviceInfo, NetworkDetail, NetworkEntry } from '@durbun/protocol';
import { translate, type Lang } from '../../i18n';
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

/** The report input for [entry]; [detail] carries the bodies when they were loaded. */
export function shareInputFor(
  entry: NetworkEntry,
  detail: NetworkDetail | null | undefined,
  context: { app?: AppSession; device?: DeviceInfo; rule?: string } = {},
): ShareInput {
  const { app, device } = context;
  const os = device ? [platformName(device), device.osVersion].filter(Boolean).join(' ') : '';
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
    app: app ? `${app.app.name}${app.app.version ? ` ${app.app.version}` : ''} (${app.app.id})` : undefined,
    // "iPhone 16 Pro (iPhone17,1) · iOS 18.2": the name reads better than a model identifier.
    device:
      device && entry.deviceId !== 'desktop'
        ? [device.model && device.model !== device.name ? `${device.name} (${device.model})` : device.name, os].filter(Boolean).join(' · ')
        : undefined,
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
