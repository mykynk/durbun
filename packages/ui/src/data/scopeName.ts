import { t } from '../i18n/core';
import { deviceDisplayName } from '../i18n/codes';
import { scopeTarget } from './scope';
import type { HubState } from './stores/hub';
import type { Scope } from './stores/scope';

/**
 * A scope in words, for sentences ("Kumbara · Pixel 8", "Pixel 8", "Tüm cihazlar"): the export dialog, the Logs
 * context bar. An app names its device too, since the same app may run on two phones.
 */
export function scopeDisplayName(scope: Scope, hub: Pick<HubState, 'apps' | 'devices' | 'deviceApps'>): string {
  if (scope.kind === 'all') return t('shell.scope.all');
  const target = scopeTarget(scope, hub);
  const deviceId = scope.kind === 'app' ? target.app?.deviceId : scope.deviceId;
  const device = deviceDisplayName(target.device, deviceId);
  if (scope.kind === 'device') return device;
  const app = target.app?.app.name || target.deviceApp?.name || target.bundleId || (scope.kind === 'app' ? scope.appId : scope.bundleId);
  return device ? `${app} · ${device}` : app;
}
