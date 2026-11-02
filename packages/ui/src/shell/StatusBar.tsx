import { useShallow } from 'zustand/react/shallow';
import { FlaskConical, Keyboard, RefreshCw, TriangleAlert, Wifi } from 'lucide-react';
import { useT } from '../i18n';
import { logStore, networkStore, reconnectNow, ui, useConnection, useDemoActive, useIngestRate, useLogVersion, useNetworkVersion, useNow, useServerSettings } from '../data';
import { StatusDot, type Tone } from '../components/Badges';
import { Sparkline } from '../components/Sparkline';
import { Tooltip } from '../components/Tooltip';
import { formatNumber } from '../lib/format';

function ConnectionIndicator() {
  const t = useT();
  const c = useConnection(
    useShallow((s) => ({
      status: s.status,
      everConnected: s.everConnected,
      nextRetryAt: s.nextRetryAt,
      expected: s.expectedLogCount,
      received: s.historyReceived,
      lastError: s.lastError,
    })),
  );
  const now = useNow(c.status === 'reconnecting' ? 500 : 5000);
  let tone: Tone = 'neutral';
  let text = '';
  let pulse = false;
  if (c.status === 'live') {
    tone = 'success';
    text = t('shell.status.connected');
  } else if (c.status === 'syncing') {
    tone = 'info';
    pulse = true;
    const pct = c.expected > 0 ? Math.min(99, Math.round((c.received / c.expected) * 100)) : 0;
    text = c.expected > 0 ? t('shell.status.syncingPct', { pct }) : t('shell.status.syncing');
  } else if (c.status === 'connecting') {
    tone = 'info';
    pulse = true;
    text = t('shell.status.connecting');
  } else {
    tone = 'danger';
    const secs = c.nextRetryAt ? Math.max(0, Math.ceil((c.nextRetryAt - now) / 1000)) : 0;
    text = c.nextRetryAt ? t('shell.status.retryIn', { secs }) : t('shell.status.reconnecting');
  }
  return (
    <Tooltip content={c.lastError && c.status === 'reconnecting' ? `${t('shell.status.lost')} · ${c.lastError}` : text}>
      <span className="st-item st-conn" role="status" aria-live="polite">
        <StatusDot tone={tone} pulse={pulse} size={7} />
        <span>{text}</span>
        {c.status === 'reconnecting' ? (
          <button type="button" className="st-link" onClick={reconnectNow}>
            <RefreshCw size={11} aria-hidden />
            {t('shell.status.retryNow')}
          </button>
        ) : null}
      </span>
    </Tooltip>
  );
}

/** Bottom bar: connection, version, totals, ingest rate, LAN/demo badges. */
export function StatusBar() {
  const t = useT();
  const server = useConnection((s) => s.server);
  const mismatch = useConnection((s) => s.protocolMismatch);
  // `server.lan` is the value at connect time; the setting follows live `settings` broadcasts.
  const lan = useServerSettings((s) => s.loaded && s.settings.allowLan);
  const demo = useDemoActive();
  const rate = useIngestRate();
  useLogVersion({ throttleMs: 1000 });
  useNetworkVersion({ throttleMs: 1000 });
  const errors = logStore.counts.error;

  return (
    <footer className="statusbar">
      <ConnectionIndicator />
      {server ? <span className="st-item st-subtle tnum">Dürbün {server.version}</span> : null}
      {mismatch ? (
        <Tooltip content={t('shell.status.protocolMismatchHint')}>
          <span className="st-item st-warn">
            <TriangleAlert size={12} aria-hidden />
            {t('shell.status.protocolMismatch')}
          </span>
        </Tooltip>
      ) : null}
      <span className="st-sep" aria-hidden />
      <span className="st-item">
        <span className="st-label">{t('shell.status.logs')}</span>
        <span className="st-value tnum">{formatNumber(logStore.size)}</span>
      </span>
      <span className="st-item">
        <span className="st-label">{t('shell.status.errors')}</span>
        <span className={errors > 0 ? 'st-value st-value--danger tnum' : 'st-value tnum'}>{formatNumber(errors)}</span>
      </span>
      <span className="st-item">
        <span className="st-label">{t('shell.status.requests')}</span>
        <span className="st-value tnum">{formatNumber(networkStore.size)}</span>
      </span>
      <span className="st-sep" aria-hidden />
      <Tooltip content={t('shell.status.rateHint')}>
        <span className="st-item st-rate">
          <Sparkline values={rate.history.length > 1 ? rate.history.slice(-40) : [0, 0]} width={52} height={12} strokeWidth={1.25} color="var(--accent)" />
          <span className="st-value tnum">{t('shell.status.rate', { rate: formatNumber(Math.round(rate.logsPerSec)) })}</span>
        </span>
      </Tooltip>
      <span className="grow" />
      {server && lan ? (
        <Tooltip content={server.hostAddresses.length ? t('shell.status.lanHint', { hosts: server.hostAddresses.join(', ') }) : t('shell.status.lanOn')}>
          <span className="st-badge st-badge--warn">
            <Wifi size={11} aria-hidden />
            LAN
          </span>
        </Tooltip>
      ) : null}
      {server && demo ? (
        <Tooltip content={t('shell.status.demoHint')}>
          <span className="st-badge st-badge--accent">
            <FlaskConical size={11} aria-hidden />
            Demo
          </span>
        </Tooltip>
      ) : null}
      <Tooltip content={t('shell.shortcuts.title')} shortcut="?">
        <button type="button" className="st-icon" onClick={ui.openShortcuts} aria-label={t('shell.shortcuts.title')}>
          <Keyboard size={13} />
        </button>
      </Tooltip>
    </footer>
  );
}
