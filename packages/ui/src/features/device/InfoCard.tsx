import type { ReactNode } from 'react';
import { Battery, BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, Laptop, Smartphone, Usb, Wifi } from 'lucide-react';
import type { DeviceInfo, LogStreamStatus } from '@durbun/protocol';
import { useNow } from '../../data';
import { Callout, CopyButton, StatusDot, formatDateTime, formatPercent, formatRelative, type IconType, type Tone } from '../../components';
import { useT } from '../../i18n';
import { fixHint, logStreamText, stateText } from './codes';
import { batteryBucket, densityScale, formatScale, logicalSize, osLine } from './model';
import { DeviceCard } from './useAction';

const CONNECTION_ICON: Record<DeviceInfo['connection'], IconType> = { usb: Usb, wifi: Wifi, local: Laptop, unknown: Smartphone };

export const LOG_TONE: Record<LogStreamStatus, Tone> = {
  streaming: 'success',
  starting: 'info',
  stopped: 'neutral',
  unavailable: 'warn',
  error: 'danger',
};

export function stateTone(d: Pick<DeviceInfo, 'state'>): Tone {
  return d.state === 'online' ? 'success' : d.state === 'disconnected' ? 'neutral' : 'warn';
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dv-info__row">
      <dt className="dv-info__key">{label}</dt>
      <dd className="dv-info__value">{children}</dd>
    </div>
  );
}

export function InfoCard({ device }: { device: DeviceInfo }) {
  const t = useT();
  // Re-render every 30 s for relative times; compare against the real clock (device updates re-render sooner).
  useNow(30_000);
  const now = Date.now();
  const ago = (ts: number) => formatRelative(Math.min(ts, now), now);
  const scale = densityScale(device.screen?.density);
  const logical = device.screen ? logicalSize(device.screen, scale) : undefined;
  const os = osLine(device);
  const ConnIcon = CONNECTION_ICON[device.connection] ?? Smartphone;
  const stateHint = fixHint(device.stateCode);
  const logHint = device.logs.status === 'streaming' ? undefined : fixHint(device.logs.code);
  const battery = device.battery;
  const BatteryIcon = battery
    ? battery.charging
      ? BatteryCharging
      : { full: BatteryFull, medium: BatteryMedium, low: BatteryLow }[batteryBucket(battery.level)]
    : Battery;
  const serialLabel = device.platform === 'ios' ? t('device.info.udid') : t('device.info.serial');

  return (
    <DeviceCard section="info" title={t('device.info.title')} icon={Smartphone}>
      {device.state !== 'online' || stateHint ? (
        <Callout tone={device.state === 'online' || device.state === 'disconnected' ? 'info' : 'warn'} title={stateText(device)} className="dv-info__callout">
          {stateHint ?? device.stateDetail ?? (device.state === 'disconnected' ? t('device.readOnly.description') : null)}
          {device.state === 'disconnected' && stateHint ? <span className="dv-info__readonly">{t('device.readOnly.description')}</span> : null}
        </Callout>
      ) : null}
      <dl className="dv-info">
        <Row label={t('device.info.name')}>{device.name}</Row>
        {device.model && device.model !== device.name ? (
          <Row label={t('device.info.model')}>
            <span className="mono">{device.model}</span>
          </Row>
        ) : null}
        {device.manufacturer ? <Row label={t('device.info.manufacturer')}>{device.manufacturer}</Row> : null}
        {os ? <Row label={t('device.info.os')}>{os}</Row> : null}
        {device.serial ? (
          <Row label={serialLabel}>
            <span className="dv-info__inline">
              <span className="mono selectable truncate" title={device.serial}>
                {device.serial}
              </span>
              <CopyButton value={device.serial} size="xs" label={t('device.info.copySerial')} />
            </span>
          </Row>
        ) : null}
        <Row label={t('device.info.connection')}>
          <span className="dv-info__inline">
            <ConnIcon size={14} aria-hidden className="dv-info__icon" />
            {t(`device.info.connectionType.${device.connection}`)}
          </span>
        </Row>
        <Row label={t('device.info.kind')}>{t(`device.info.kindType.${device.kind}`)}</Row>
        {battery ? (
          <Row label={t('device.info.battery')}>
            <span className="dv-info__inline">
              <BatteryIcon size={15} aria-hidden className={battery.level < 20 && !battery.charging ? 'dv-info__icon tone-warn' : 'dv-info__icon'} />
              <span className="tnum">{formatPercent(battery.level)}</span>
              <span className="muted">· {battery.charging ? t('device.info.charging') : t('device.info.onBattery')}</span>
            </span>
          </Row>
        ) : null}
        {device.screen ? (
          <Row label={t('device.info.screen')}>
            <span className="dv-info__inline wrap">
              <span className="mono">
                {device.screen.width} × {device.screen.height}
              </span>
              {scale ? <span className="mono muted">{formatScale(scale)}</span> : null}
              {logical ? (
                <span className="muted">
                  ·{' '}
                  {t('device.info.logical', {
                    width: logical.width,
                    height: logical.height,
                    unit: device.platform === 'ios' ? 'pt' : 'dp',
                  })}
                </span>
              ) : null}
            </span>
          </Row>
        ) : null}
        <Row label={t('device.info.logs')}>
          <span className="dv-info__stack">
            <span className="dv-info__inline">
              <StatusDot tone={LOG_TONE[device.logs.status]} pulse={device.logs.status === 'starting'} size={7} />
              <span>{logStreamText(device)}</span>
              {device.logs.via ? <span className="muted">· {t('device.info.via', { via: device.logs.via })}</span> : null}
            </span>
            {device.logs.detail && device.logs.status !== 'streaming' ? <span className="dv-info__detail">{device.logs.detail}</span> : null}
            {logHint ? <span className="dv-info__detail">{logHint}</span> : null}
          </span>
        </Row>
        <Row label={t('device.info.state')}>
          <span className="dv-info__inline">
            <StatusDot tone={stateTone(device)} size={7} />
            <span>{stateText(device)}</span>
          </span>
        </Row>
        <Row label={t('device.info.firstSeen')}>
          <span className="dv-info__inline wrap">
            <span>{formatDateTime(device.firstSeen)}</span>
            <span className="muted">· {ago(device.firstSeen)}</span>
          </span>
        </Row>
        <Row label={t('device.info.lastSeen')}>
          <span className="dv-info__inline wrap">
            <span>{formatDateTime(device.lastSeen)}</span>
            <span className="muted">· {ago(device.lastSeen)}</span>
          </span>
        </Row>
        <Row label={t('device.info.id')}>
          <span className="dv-info__inline">
            <span className="mono selectable muted truncate">{device.id}</span>
            <CopyButton value={device.id} size="xs" label={t('device.info.copyId')} />
          </span>
        </Row>
      </dl>
    </DeviceCard>
  );
}
