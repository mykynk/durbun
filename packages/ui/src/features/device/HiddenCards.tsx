import { EyeOff, Stethoscope } from 'lucide-react';
import type { DeviceActionId, DeviceInfo } from '@durbun/protocol';
import { Button } from '../../components';
import { ui } from '../../data';
import { hiddenDeviceActions, hiddenDeviceCards } from '../../data/explain';
import { useT } from '../../i18n';
import { codeText } from './codes';
import { DeviceCard } from './useAction';

/** Reasons a person fixes on the Mac (a tool): the card offers the System check for them. */
const MAC_FIXES = new Set(['action.toolMissing', 'action.toolTooOld', 'logs.idevicesyslogMissing']);

/** The server's `detail` for these is English; say them in the UI language instead. */
function reasonText(t: ReturnType<typeof useT>, code: string, params?: Record<string, string | number>): string {
  if (params?.tool === 'devicectl' && code === 'action.toolTooOld') return t('device.hiddenServer.devicectlTooOld');
  if (params?.tool === 'devicectl' && code === 'action.toolMissing') return t('device.hiddenServer.devicectlMissing');
  return codeText(code, params) ?? code;
}

/**
 * What this device cannot do right now, and why, instead of silently leaving cards out. A server that reports
 * `unavailableActions` says it per action (grouped by reason; actions a card already explains are left out); an
 * older one gets the iPhone guess (`hiddenDeviceCards`).
 */
export function HiddenCardsCard({ device, shownInline }: { device: DeviceInfo; shownInline?: ReadonlySet<DeviceActionId> }) {
  const t = useT();
  const groups = hiddenDeviceActions(device, shownInline);
  if (groups) {
    if (groups.length === 0) return null;
    const macFix = groups.some((g) => MAC_FIXES.has(g.code));
    return (
      <DeviceCard
        section="hidden"
        className="dv-card--quiet"
        title={t('device.hidden.title')}
        icon={EyeOff}
        description={t('device.hiddenServer.hint')}
        actions={
          macFix ? (
            <Button size="sm" variant="ghost" icon={Stethoscope} onClick={ui.openDoctor}>
              {t('device.hidden.doctor')}
            </Button>
          ) : undefined
        }
      >
        <ul className="dv-hidden">
          {groups.map((g) => (
            <li key={`${g.code}|${g.actions.join(',')}`}>
              <span className="dv-hidden__card">{g.actions.map((a) => t(`device.actionName.${a}`)).join(' · ')}</span>
              <span className="dv-hint">{reasonText(t, g.code, g.params)}</span>
            </li>
          ))}
        </ul>
      </DeviceCard>
    );
  }
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
