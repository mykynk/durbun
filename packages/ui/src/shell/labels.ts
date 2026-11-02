import type { AppSession, DeviceInfo } from '@durbun/protocol';
import { t } from '../i18n/core';
import { deviceDisplayName } from '../i18n/codes';
import type { Tone } from '../components/Badges';

/**
 * "Android 15 · API 35", "iOS 18.2", "Simülatör · iOS 18.2".
 * `origin: false` leaves out the "Demo" / "İçe aktarıldı" prefix (the sidebar shows those as a section / badge).
 */
export function deviceSubtitle(d: DeviceInfo, opts: { origin?: boolean } = {}): string {
  const origin = opts.origin ?? true;
  const parts: string[] = [];
  const demo = d.id.startsWith('demo:');
  const imported = d.id.startsWith('import:');
  if (demo) {
    if (origin) parts.push(t('shell.device.demo'));
  } else if (imported) {
    if (origin) parts.push(t('shell.device.imported'));
  } else if (d.kind === 'simulator') parts.push(t('shell.device.simulator'));
  else if (d.kind === 'emulator') parts.push(t('shell.device.emulator'));
  if (d.platform === 'android') {
    if (d.osVersion) parts.push(`Android ${d.osVersion}`);
    if (d.apiLevel) parts.push(`API ${d.apiLevel}`);
  } else if (d.platform === 'ios') {
    if (d.osVersion) parts.push(`iOS ${d.osVersion}`);
  } else if (d.osVersion) parts.push(d.osVersion);
  if (parts.length === 0 && d.model && d.model !== d.name && d.id !== 'desktop') parts.push(d.model);
  return parts.join(' · ');
}

export function stateTone(d: DeviceInfo): Tone {
  if (d.id.startsWith('import:')) return 'neutral';
  switch (d.state) {
    case 'online':
      return 'success';
    case 'unauthorized':
    case 'offline':
      return 'warn';
    default:
      return 'neutral';
  }
}

/** USB / Wi-Fi badge text for physical devices; undefined when not meaningful. */
export function connectionLabel(d: DeviceInfo): string | undefined {
  if (d.kind === 'virtual' || d.id.startsWith('demo:') || d.id.startsWith('import:') || d.id === 'desktop') return undefined;
  if (d.connection === 'usb') return 'USB';
  if (d.connection === 'wifi') return 'Wi-Fi';
  return undefined;
}

/** File label of an imported session ("Imported from <label>" → "<label>"). */
export function importLabel(d: Pick<DeviceInfo, 'id' | 'stateDetail'>): string | undefined {
  if (!d.id.startsWith('import:')) return undefined;
  const m = /^Imported from (.+)$/.exec(d.stateDetail ?? '');
  return m?.[1]?.trim() || undefined;
}

/** `net:` devices only carry SDK data (no device logs, no device actions). */
export function isNetworkOnly(d: Pick<DeviceInfo, 'id' | 'logs'>): boolean {
  return d.id.startsWith('net:') || d.logs.code === 'logs.networkOnly';
}

export function appTitle(a: AppSession): string {
  return a.app.name || a.app.id;
}

export function appVersion(a: AppSession): string | undefined {
  if (!a.app.version) return undefined;
  return a.app.build && a.app.build !== a.app.version ? `${a.app.version} (${a.app.build})` : a.app.version;
}

/** Localized display name (the virtual desktop device gets "Masaüstü · yeniden gönderilenler"). */
export function deviceName(d: DeviceInfo | undefined, fallbackId?: string): string {
  if (!d && !fallbackId) return t('shell.scope.unknownDevice');
  return deviceDisplayName(d, fallbackId) || t('shell.scope.unknownDevice');
}
