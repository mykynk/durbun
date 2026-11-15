import { RotateCcw, SlidersHorizontal } from 'lucide-react';
import type { DeviceInfo, DeviceSettingOverride } from '@durbun/protocol';
import { Button } from '../../components';
import { useT, type TFunction } from '../../i18n';
import { ActionErrorCallout, DeviceCard, useDeviceAction } from './useAction';

function valueText(o: DeviceSettingOverride, v: string, t: TFunction): string {
  if (v === 'default') return t('device.overrides.default');
  if (o.action === 'appearance') return v === 'yes' ? t('device.overrides.dark') : v === 'no' ? t('device.overrides.light') : v;
  if (o.action === 'font-scale') return `×${v}`;
  return v;
}

/**
 * Phone settings Dürbün changed (animations, font size, appearance): they stay changed after the phone is unplugged,
 * so each is listed with its value before and a one-click "Undo" (the same action with `{ restore: true }`).
 */
export function OverridesCard({ device }: { device: DeviceInfo }) {
  const t = useT();
  const { run, isPending, error, clearError } = useDeviceAction(device.id);
  const list = device.settingOverrides ?? [];
  if (list.length === 0) return null;
  return (
    <DeviceCard section="overrides" title={t('device.overrides.title')} icon={SlidersHorizontal} description={t('device.overrides.hint')}>
      <ActionErrorCallout error={error} onDismiss={clearError} />
      {list.map((o) => {
        const name = t(`device.overrides.action.${o.action}`);
        return (
          <div key={o.action} className="dv-action-row">
            <div className="dv-action-row__text">
              <span className="dv-action-row__title">{t('device.overrides.row', { name, value: valueText(o, o.current, t) })}</span>
              <span className="dv-hint">{t('device.overrides.before', { value: valueText(o, o.previous, t) })}</span>
            </div>
            <Button
              size="sm"
              icon={RotateCcw}
              loading={isPending(`restore-${o.action}`)}
              aria-label={t('device.overrides.undoNamed', { name })}
              onClick={() => void run({ key: `restore-${o.action}`, action: o.action, params: { restore: true }, success: t('device.overrides.restored', { name }), failure: t('device.overrides.restoreFailed') })}
            >
              {t('device.overrides.undo')}
            </Button>
          </div>
        );
      })}
    </DeviceCard>
  );
}
