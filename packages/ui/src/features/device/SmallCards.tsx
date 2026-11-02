import { BatteryFull, Eraser, PanelTop, RotateCcw, ScrollText, Signal, Sparkles, Wifi } from 'lucide-react';
import type { DeviceInfo } from '@durbun/protocol';
import { Button, StatusDot } from '../../components';
import { useT } from '../../i18n';
import { logStreamText } from './codes';
import { LOG_TONE } from './InfoCard';
import { hasAction } from './model';
import { ActionErrorCallout, DeviceCard, useDeviceAction } from './useAction';

/** iOS simulator status bar override (`status-bar { mode: clean | reset }`). */
export function StatusBarCard({ device }: { device: DeviceInfo }) {
  const t = useT();
  const { run, isPending, error, clearError } = useDeviceAction(device.id);
  const set = (mode: 'clean' | 'reset') =>
    void run({ key: `bar-${mode}`, action: 'status-bar', params: { mode }, success: t(`device.bar.done.${mode}`), failure: t('device.bar.failed') });
  return (
    <DeviceCard section="status-bar" title={t('device.bar.title')} icon={PanelTop} description={t('device.bar.hint')}>
      <ActionErrorCallout error={error} onDismiss={clearError} />
      <div className="dv-statusbar" aria-label={t('device.bar.preview')} role="img">
        <span className="dv-statusbar__time">9:41</span>
        <span className="grow" />
        <Signal size={14} aria-hidden />
        <Wifi size={14} aria-hidden />
        <BatteryFull size={16} aria-hidden />
      </div>
      <p className="dv-hint">{t('device.bar.preview')}</p>
      <div className="dv-row">
        <Button size="sm" variant="primary" icon={Sparkles} loading={isPending('bar-clean')} onClick={() => set('clean')}>
          {t('device.bar.clean')}
        </Button>
        <Button size="sm" icon={RotateCcw} loading={isPending('bar-reset')} onClick={() => set('reset')}>
          {t('device.bar.reset')}
        </Button>
      </div>
    </DeviceCard>
  );
}

/** Device log stream maintenance: clear the device buffer (Android) and restart the stream. */
export function LogsCard({ device }: { device: DeviceInfo }) {
  const t = useT();
  const { run, isPending, error, clearError } = useDeviceAction(device.id);
  const canClear = hasAction(device, 'logs-clear-buffer');
  const canRestart = hasAction(device, 'logs-restart');
  return (
    <DeviceCard section="logs" title={t('device.logs.title')} icon={ScrollText}>
      <ActionErrorCallout error={error} onDismiss={clearError} />
      <div className="dv-row dv-logstate">
        <StatusDot tone={LOG_TONE[device.logs.status]} pulse={device.logs.status === 'starting'} size={7} />
        <span>{logStreamText(device)}</span>
        {device.logs.via ? <span className="muted">· {t('device.info.via', { via: device.logs.via })}</span> : null}
      </div>
      {canClear ? (
        <div className="dv-action-row">
          <div className="dv-action-row__text">
            <span className="dv-action-row__title">{t('device.logs.clear')}</span>
            <span className="dv-hint">{t('device.logs.clearHint')}</span>
          </div>
          <Button
            size="sm"
            icon={Eraser}
            loading={isPending('logs-clear-buffer')}
            onClick={() => void run({ action: 'logs-clear-buffer', success: t('device.logs.cleared'), failure: t('device.logs.clearFailed') })}
          >
            {t('common.clear')}
          </Button>
        </div>
      ) : null}
      {canRestart ? (
        <div className="dv-action-row">
          <div className="dv-action-row__text">
            <span className="dv-action-row__title">{t('device.logs.restart')}</span>
            <span className="dv-hint">{t('device.logs.restartHint')}</span>
          </div>
          <Button
            size="sm"
            icon={RotateCcw}
            loading={isPending('logs-restart')}
            onClick={() => void run({ action: 'logs-restart', success: t('device.logs.restarted'), failure: t('device.logs.restartFailed') })}
          >
            {t('device.apps.restart')}
          </Button>
        </div>
      ) : null}
    </DeviceCard>
  );
}
