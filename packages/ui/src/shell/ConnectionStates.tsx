import { useShallow } from 'zustand/react/shallow';
import { Archive, PlugZap, RefreshCw, TriangleAlert, Unplug } from 'lucide-react';
import { useT } from '../i18n';
import { deviceDisplayName, deviceStateText } from '../i18n/codes';
import { reconnectNow, ui, useConnection, useHub, useNow, useScope } from '../data';
import { Button } from '../components/Button';
import { Callout } from '../components/Layout';
import { Spinner } from '../components/Spinner';
import { DurbunMark } from '../components/Icons';
import { Snippet } from './Snippet';
import { repoDir } from './repo';
import { isDesktopApp } from '../lib/platform';
import { importLabel } from './labels';

/** Full-area state while the server has never been reached. */
export function ServerUnreachable() {
  const t = useT();
  const { status, attempt, nextRetryAt, lastError } = useConnection(
    useShallow((s) => ({ status: s.status, attempt: s.attempt, nextRetryAt: s.nextRetryAt, lastError: s.lastError })),
  );
  const now = useNow(500);
  const secs = nextRetryAt ? Math.max(0, Math.ceil((nextRetryAt - now) / 1000)) : 0;
  const struggling = attempt >= 2;
  return (
    <div className="onboarding onboarding--center">
      <div className="unreachable">
        <DurbunMark tile size={44} />
        {!struggling ? (
          <div className="connecting" role="status">
            <Spinner size={16} />
            <span>{t('shell.status.connecting')}</span>
          </div>
        ) : (
          <>
            <h1 className="onboarding__title">{t('shell.unreachable.title')}</h1>
            {isDesktopApp() ? (
              // The Mac app starts its own server: CLI commands would only confuse here.
              <p className="onboarding__lead">{t('shell.unreachable.leadDesktop')}</p>
            ) : (
              <>
                <p className="onboarding__lead">{t('shell.unreachable.lead')}</p>
                <Snippet lang="shell" code={`cd "${repoDir()}"\nnpm run build && npm start   # ${t('shell.unreachable.demoHint')}: npm run demo`} />
              </>
            )}
            <div className="row gap-2 center">
              <Button variant="primary" icon={RefreshCw} onClick={reconnectNow}>
                {t('shell.status.retryNow')}
              </Button>
              <span className="muted text-sm tnum" role="status">
                {status === 'reconnecting' && nextRetryAt ? t('shell.status.retryIn', { secs }) : t('shell.status.connecting')}
              </span>
            </div>
            {lastError ? <p className="subtle text-xs mono">{lastError}</p> : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Thin banner above the content while a previously working connection is down. */
export function ConnectionBanner() {
  const t = useT();
  const { status, everConnected, nextRetryAt } = useConnection(useShallow((s) => ({ status: s.status, everConnected: s.everConnected, nextRetryAt: s.nextRetryAt })));
  const now = useNow(500);
  if (!everConnected || status !== 'reconnecting') return null;
  const secs = nextRetryAt ? Math.max(0, Math.ceil((nextRetryAt - now) / 1000)) : 0;
  return (
    <div className="banner banner--danger" role="alert">
      <Unplug size={14} aria-hidden />
      <span className="banner__text">
        <b>{t('shell.status.lost')}</b> · {nextRetryAt ? t('shell.status.retryIn', { secs }) : t('shell.status.reconnecting')} · {t('shell.status.dataKept')}
      </span>
      <Button size="sm" variant="ghost" icon={RefreshCw} onClick={reconnectNow}>
        {t('shell.status.retryNow')}
      </Button>
    </div>
  );
}

/** Extra advice per device state code (the state text itself comes from `deviceStateText`). */
const ATTENTION_TIPS: Record<string, string> = {
  'device.unauthorized': 'shell.attention.tips.unauthorized',
  'device.untrusted': 'shell.attention.tips.untrusted',
  'device.offline': 'shell.attention.tips.offline',
  'device.noPermissions': 'shell.attention.tips.noPermissions',
  'device.notBooted': 'shell.attention.tips.notBooted',
};

/** Hint when the scoped device needs attention (unauthorized / offline / disconnected / imported recording). */
export function DeviceAttentionBanner() {
  const t = useT();
  const scope = useScope();
  const device = useHub((s) => {
    if (scope.kind === 'device' || scope.kind === 'deviceApp') return s.devices[scope.deviceId];
    if (scope.kind === 'app') {
      const a = s.apps[scope.appId];
      return a ? s.devices[a.deviceId] : undefined;
    }
    return undefined;
  });
  if (!device) return null;
  const name = deviceDisplayName(device);
  if (device.id.startsWith('import:')) {
    const source = importLabel(device);
    return (
      <div className="banner banner--neutral" role="status">
        <Archive size={14} aria-hidden />
        <span className="banner__text">
          <b>{name}</b> · {t('shell.device.importedRecording')}
          {source ? <span className="subtle"> · {source}</span> : null} · {t('shell.attention.readOnly')}
        </span>
      </div>
    );
  }
  if (device.state === 'online') return null;
  if (device.state === 'disconnected') {
    return (
      <div className="banner banner--neutral" role="status">
        <PlugZap size={14} aria-hidden />
        <span className="banner__text">
          <b>{name}</b> · {deviceStateText(device)} · {t('shell.attention.dataKept')}
        </span>
      </div>
    );
  }
  const tip = device.stateCode ? ATTENTION_TIPS[device.stateCode] : undefined;
  return (
    <div className="banner-wrap">
      <Callout
        tone="warn"
        icon={TriangleAlert}
        compact
        title={`${name} · ${t(`code.state.${device.state}`)}`}
        actions={
          <Button size="sm" variant="ghost" onClick={ui.openDoctor}>
            {t('shell.doctor.title')}
          </Button>
        }
      >
        <span title={device.stateDetail}>{deviceStateText(device)}</span>
        {tip ? <span className="subtle"> {t(tip)}</span> : null}
      </Callout>
    </div>
  );
}
