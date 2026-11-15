import { EyeOff, Stethoscope } from 'lucide-react';
import type { DeviceInfo } from '@durbun/protocol';
import { Button } from '../../components';
import { ui } from '../../data';
import { hiddenDeviceCards } from '../../data/explain';
import { useT } from '../../i18n';
import { DeviceCard } from './useAction';

/** Cards this iPhone would have with every tool in place, said instead of silently left out (with the fix). */
export function HiddenCardsCard({ device }: { device: DeviceInfo }) {
  const t = useT();
  const hidden = hiddenDeviceCards(device);
  if (hidden.length === 0) return null;
  return (
    <DeviceCard
      section="hidden"
      className="dv-card--quiet"
      title={t('device.hidden.title')}
      icon={EyeOff}
      description={t('device.hidden.hint')}
      actions={
        <Button size="sm" variant="ghost" icon={Stethoscope} onClick={ui.openDoctor}>
          {t('device.hidden.doctor')}
        </Button>
      }
    >
      <ul className="dv-hidden">
        {hidden.map((h) => (
          <li key={h.card}>
            <span className="dv-hidden__card">{t(`device.hidden.card.${h.card}`)}</span>
            <span className="dv-hint">{t(`device.hidden.reason.${h.reason}`)}</span>
          </li>
        ))}
      </ul>
    </DeviceCard>
  );
}
