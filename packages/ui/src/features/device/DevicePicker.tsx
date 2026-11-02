import { clsx } from 'clsx';
import { Check, Smartphone } from 'lucide-react';
import type { AppSession, DeviceInfo } from '@durbun/protocol';
import { EmptyState, PlatformIcon, StatusDot } from '../../components';
import { useT } from '../../i18n';
import { stateText } from './codes';
import { stateTone } from './InfoCard';
import { osLine } from './model';

/** Device cards shown on the "all devices" scope; the choice is remembered by the caller. */
export function DevicePicker({
  devices,
  apps,
  selectedId,
  onPick,
}: {
  devices: readonly DeviceInfo[];
  apps: Record<string, AppSession>;
  selectedId?: string;
  onPick: (id: string) => void;
}) {
  const t = useT();
  if (devices.length === 0) {
    return <EmptyState icon={Smartphone} title={t('device.picker.noDevices')} description={t('device.picker.noDevicesHint')} size="lg" />;
  }
  const appCount = (id: string) => new Set(Object.values(apps).filter((a) => a.deviceId === id).map((a) => a.app.id)).size;
  return (
    <div className="dv-picker">
      <div className="dv-picker__head">
        <h2 className="dv-picker__title">{t('device.picker.title')}</h2>
        <p className="dv-picker__desc">{t('device.picker.description')}</p>
      </div>
      <ul className="dv-picker__grid">
        {devices.map((d) => {
          const count = appCount(d.id);
          const kind = t(`device.info.kindType.${d.kind}`);
          const os = osLine(d);
          return (
            <li key={d.id}>
              <button type="button" className={clsx('dv-pick', d.id === selectedId && 'is-selected', d.state !== 'online' && 'is-offline')} onClick={() => onPick(d.id)} aria-pressed={d.id === selectedId}>
                <span className="dv-pick__icon">
                  <PlatformIcon device={d} size={20} />
                </span>
                <span className="dv-pick__main">
                  <span className="dv-pick__name truncate">{d.name}</span>
                  <span className="dv-pick__sub truncate">{[os, kind].filter(Boolean).join(' · ')}</span>
                  <span className="dv-pick__meta">
                    <StatusDot tone={stateTone(d)} size={7} />
                    <span className="truncate">{stateText(d)}</span>
                    {count > 0 ? <span className="subtle">· {t('device.picker.apps', { count })}</span> : null}
                  </span>
                </span>
                {d.id === selectedId ? <Check size={16} aria-hidden className="dv-pick__check" /> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
