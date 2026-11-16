import { useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { FlaskConical, Info, Keyboard, Power, RefreshCw, TriangleAlert, Wifi } from 'lucide-react';
import { useT } from '../i18n';
import { logStore, networkStore, reconnectNow, ui, useConnection, useDemoActive, useIngestRate, useLogVersion, useNetworkVersion, useNow, useServerSettings } from '../data';
import { StatusDot, type Tone } from '../components/Badges';
import { Sparkline } from '../components/Sparkline';
import { Tooltip } from '../components/Tooltip';
import { DropdownMenu } from '../components/Menu';
import { Popover } from '../components/Popover';
import { Button } from '../components/Button';
import { formatNumber } from '../lib/format';
import { isDesktopApp } from '../lib/platform';
import { setDemo } from './actions';

/**
 * The UI and the server speak different protocol versions. In the Mac app that means it reached another Dürbün
 * (an older command-line server on the same port); in a browser tab, a page loaded before the server changed.
 */
function MismatchBadge() {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const desktop = isDesktopApp();
  return (
    <>
      <button ref={ref} type="button" className="st-item st-warn st-button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog">
        <TriangleAlert size={12} aria-hidden />
        {t('shell.status.protocolMismatch')}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} side="top" align="start" width={340} role="dialog" aria-label={t('shell.status.protocolMismatch')} className="st-pop">
        <p className="st-pop__text">{desktop ? t('shell.status.protocolMismatchDesktop') : t('shell.status.protocolMismatchBrowser')}</p>
        <div className="st-pop__actions">
          {desktop ? (
            <Button size="sm" variant="secondary" icon={Info} onClick={() => (setOpen(false), ui.openSettings('about'))}>
              {t('shell.status.openAbout')}
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon={RefreshCw} onClick={() => window.location.reload()}>
              {t('common.crash.reload')}
            </Button>
          )}
        </div>
      </Popover>
    </>
  );
}

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
      resumed: s.resumed,
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
    <Tooltip
      content={
        c.lastError && c.status === 'reconnecting'
          ? `${t('shell.status.lost')} · ${c.lastError}`
          : c.status === 'live' && c.resumed
            ? // Only in the tooltip: after a short drop the window kept its data and loaded what it missed.
              `${text} · ${t('shell.status.resumed')}`
            : text
      }
    >
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
      {mismatch ? <MismatchBadge /> : null}
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
        <Tooltip content={`${server.hostAddresses.length ? t('shell.status.lanHint', { hosts: server.hostAddresses.join(', ') }) : t('shell.status.lanOn')} · ${t('shell.status.lanAction')}`}>
          <button type="button" className="st-badge st-badge--warn" onClick={() => ui.openSettings('connection')} aria-label={`${t('shell.status.lanOn')}: ${t('shell.status.lanAction')}`}>
            <Wifi size={11} aria-hidden />
            LAN
          </button>
        </Tooltip>
      ) : null}
      {server && demo ? (
        <DropdownMenu
          side="top"
          align="end"
          minWidth={220}
          aria-label={t('shell.status.demoHint')}
          items={[
            { type: 'label', label: t('shell.status.demoHint') },
            { label: t('shell.demo.disable'), icon: Power, onSelect: () => void setDemo(false) },
          ]}
        >
          {(p) => (
            <button type="button" className="st-badge st-badge--accent" {...p} aria-label={`${t('shell.status.demoHint')}: ${t('shell.status.demoMenu')}`}>
              <FlaskConical size={11} aria-hidden />
              Demo
            </button>
          )}
        </DropdownMenu>
      ) : null}
      <Tooltip content={t('shell.shortcuts.title')} shortcut="?">
        <button type="button" className="st-icon" onClick={ui.openShortcuts} aria-label={t('shell.shortcuts.title')}>
          <Keyboard size={13} />
        </button>
      </Tooltip>
    </footer>
  );
}
