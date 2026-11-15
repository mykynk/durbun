import { RotateCcw, SlidersHorizontal } from 'lucide-react';
import type { DeviceInfo, DeviceSettingOverride } from '@durbun/protocol';
import { Button } from '../../components';
import { useHub } from '../../data';
import { useT, type TFunction } from '../../i18n';
import { ActionErrorCallout, DeviceCard, useDeviceAction } from './useAction';
import { ROTATIONS, permissionLabelKey, shortPermission, type AppRow } from './model';

export function overrideValueText(o: Pick<DeviceSettingOverride, 'action'>, v: string, t: TFunction): string {
  if (v === 'default') return t('device.overrides.default');
  switch (o.action) {
    case 'appearance':
      return v === 'yes' ? t('device.overrides.dark') : v === 'no' ? t('device.overrides.light') : v;
    case 'font-scale':
      return `×${v}`;
    case 'airplane-mode':
    case 'wifi':
    case 'mobile-data':
      return v === 'on' ? t('device.tester.valueOn') : v === 'off' ? t('device.tester.valueOff') : v;
    case 'dont-keep-activities':
    case 'animations':
      return v === '1' ? t('device.tester.valueOn') : v === '0' ? t('device.tester.valueOff') : v;
    case 'rotation':
      return (ROTATIONS as readonly string[]).includes(v) ? t(`device.tester.screen.${v}`) : v;
    case 'app-permission':
      return v === 'granted' ? t('device.overrides.granted') : v === 'revoked' ? t('device.overrides.denied') : v;
    case 'app-locale':
      return v === 'system' ? t('device.tester.app.localeSystem') : v;
    default:
      return v;
  }
}

/** The name a permission has in the permission card ("Kamera"); one the UI does not name keeps its id ("BODY_SENSORS"). */
export function permissionLabel(id: string, t: TFunction): string {
  const key = permissionLabelKey(id);
  return key ? t(key) : shortPermission(id);
}

/**
 * "Kamera izni · Pati" for app-scoped settings (the app's name when it is known, else its package), the setting's
 * name for the others.
 */
export function overrideName(o: DeviceSettingOverride, t: TFunction, appName?: string): string {
  const base = o.action === 'app-permission' && o.key ? t('device.overrides.permissionName', { permission: permissionLabel(o.key, t) }) : t(`device.actionName.${o.action}`);
  return o.appId ? t('device.overrides.scoped', { name: base, app: appName || o.appId }) : base;
}

/** What the short name leaves out (package, full permission id), for the row's tooltip. */
export function overrideDetail(o: DeviceSettingOverride): string | undefined {
  return [o.appId, o.key].filter(Boolean).join(' · ') || undefined;
}

const overrideKey = (o: DeviceSettingOverride) => `restore-${o.action}|${o.appId ?? ''}|${o.key ?? ''}`;

/**
 * Phone settings Dürbün changed (animations, font size, appearance): they stay changed after the phone is unplugged,
 * so each is listed with its value before and a one-click "Undo" (the same action with `{ restore: true }`).
 */
export function OverridesCard({ device, apps }: { device: DeviceInfo; apps?: readonly AppRow[] }) {
  const t = useT();
  const { run, isPending, error, clearError } = useDeviceAction(device.id);
  const list = device.settingOverrides ?? [];
  // App names: the Apps card's list first, else what the hub knows about the app on this device.
  const hubNames = useHub((s) => list.map((o) => (o.appId ? (s.deviceApps[`${device.id}|${o.appId}`]?.name ?? '') : '')).join('\u0000')).split('\u0000');
  if (list.length === 0) return null;
  return (
    <DeviceCard section="overrides" title={t('device.overrides.title')} icon={SlidersHorizontal} description={t('device.overrides.hint')}>
      <ActionErrorCallout error={error} onDismiss={clearError} />
      {list.map((o, i) => {
        const name = overrideName(o, t, o.appId ? apps?.find((a) => a.id === o.appId)?.name || hubNames[i] : undefined);
        const key = overrideKey(o);
        // App-scoped settings name their app (and permission) so the server finds the one to put back.
        const params = { restore: true, ...(o.appId ? { appId: o.appId } : {}), ...(o.key ? { permission: o.key } : {}) };
        return (
          <div key={key} className="dv-action-row">
            <div className="dv-action-row__text">
              <span className="dv-action-row__title" title={overrideDetail(o)}>
                {t('device.overrides.row', { name, value: overrideValueText(o, o.current, t) })}
              </span>
              <span className="dv-hint">{t('device.overrides.before', { value: overrideValueText(o, o.previous, t) })}</span>
            </div>
            <Button
              size="sm"
              icon={RotateCcw}
              loading={isPending(key)}
              aria-label={t('device.overrides.undoNamed', { name })}
              onClick={() => void run({ key, action: o.action, params, success: t('device.overrides.restored', { name }), failure: t('device.overrides.restoreFailed') })}
            >
              {t('device.overrides.undo')}
            </Button>
          </div>
        );
      })}
    </DeviceCard>
  );
}
