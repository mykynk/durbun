import { useMemo } from 'react';
import { BookOpen, Cable, Gauge, Globe, OctagonX, ShieldCheck, Smartphone, Store } from 'lucide-react';
import type { AppSession, DeviceApp, DeviceInfo } from '@durbun/protocol';
import { useLanguage, useT } from '../i18n';
import { EXPLAIN_CAPABILITIES, explainSources, type ExplainResult } from '../data/explain';
import { ui, useUi } from '../data/stores/ui';
import { Dialog } from '../components/Dialog';
import { Button } from '../components/Button';
import type { IconType } from '../components/Icons';
import { capabilityLabel, sourceLabel, statusLabel } from './text';
import { RichText, StatusIcon } from './components';
import './sources.css';

/* Synthetic inputs for the "which build shows what" table: the same rules as every app row. */
const NOW = 0;
const DEVICE: DeviceInfo = {
  id: 'android:example',
  platform: 'android',
  kind: 'physical',
  name: 'Android',
  connection: 'usb',
  state: 'online',
  logs: { status: 'streaming', via: 'logcat' },
  actions: [],
  firstSeen: NOW,
  lastSeen: NOW,
};

function deviceApp(source: DeviceApp['install']['source'], buildType: DeviceApp['buildType']): DeviceApp {
  return { key: `${DEVICE.id}|app`, deviceId: DEVICE.id, id: 'app', buildType, install: { source }, pids: [1], running: true, lastActivity: NOW };
}

function session(transport: AppSession['transport'], platform: AppSession['sdk']['platform'], caps: AppSession['capabilities'], actions: number): AppSession {
  return {
    id: `x:${transport}`,
    sessionKey: transport,
    deviceId: DEVICE.id,
    sdk: { name: 'durbun', version: '0', platform },
    app: { name: 'App', id: 'app' },
    transport,
    connected: true,
    connectedAt: NOW,
    capabilities: caps,
    actions: Array.from({ length: actions }, (_, i) => ({ id: `a${i}`, kind: 'button' as const, label: '' })),
    stats: { logs: 0, requests: 0, errors: 0 },
  };
}

export function buildMatrix(): { debug: ExplainResult; internal: ExplainResult; store: ExplainResult } {
  return {
    debug: explainSources({ device: DEVICE, deviceApp: deviceApp('adb', 'debug'), sessions: [session('vm-service', 'dart-vm', ['logs', 'network', 'metrics'], 4)] }),
    internal: explainSources({
      device: DEVICE,
      deviceApp: deviceApp('firebase', 'release'),
      sessions: [session('adb-reverse', 'flutter', ['logs', 'network', 'mocks', 'metrics', 'events', 'crash', 'commands'], 4)],
    }),
    store: explainSources({ device: DEVICE, deviceApp: deviceApp('play', 'release'), sessions: [] }),
  };
}

function Card({ icon: Icon, title, body, wide }: { icon: IconType; title: string; body: string; wide?: boolean }) {
  return (
    <section className={wide ? 'src-explainer__card src-explainer__card--wide' : 'src-explainer__card'}>
      <h3>
        <Icon size={15} aria-hidden />
        {title}
      </h3>
      <p>
        <RichText text={body} />
      </p>
    </section>
  );
}

/** The general explainer body (dialog content; also rendered inline in tests). */
export function DataSourcesExplainer() {
  const t = useT();
  const lang = useLanguage();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matrix = useMemo(() => buildMatrix(), [lang]);
  const cols = [
    { key: 'debug', label: t('sources.explainer.matrix.debug'), result: matrix.debug },
    { key: 'internal', label: t('sources.explainer.matrix.internal'), result: matrix.internal },
    { key: 'store', label: t('sources.explainer.matrix.store'), result: matrix.store },
  ];
  return (
    <div className="src-explainer">
      <div className="src-explainer__grid">
        <Card icon={Cable} title={t('sources.explainer.deviceLogs.title')} body={t('sources.explainer.deviceLogs.body')} />
        <Card icon={Smartphone} title={t('sources.explainer.appData.title')} body={t('sources.explainer.appData.body')} />
        <Card icon={OctagonX} title={t('sources.explainer.crashes.title')} body={t('sources.explainer.crashes.body')} />
        <Card icon={Gauge} title={t('sources.explainer.metrics.title')} body={t('sources.explainer.metrics.body')} />
        <Card icon={Globe} title={t('sources.explainer.network.title')} body={t('sources.explainer.network.body')} wide />
        <Card icon={Store} title={t('sources.explainer.store.title')} body={t('sources.explainer.store.body')} wide />
      </div>
      <section>
        <h3 className="sdk-step__title">{t('sources.explainer.matrix.title')}</h3>
        <table className="src-matrix-table">
          <thead>
            <tr>
              <th scope="col">{t('sources.explainer.matrix.capability')}</th>
              {cols.map((c) => (
                <th key={c.key} scope="col">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {EXPLAIN_CAPABILITIES.map((cap) => (
              <tr key={cap}>
                <td>{capabilityLabel(cap)}</td>
                {cols.map((c) => {
                  const row = c.result.rows.find((r) => r.capability === cap);
                  if (!row) return <td key={c.key} />;
                  return (
                    <td key={c.key}>
                      <span className="src-cell">
                        <StatusIcon status={row.status} size={14} />
                        <span className="src-cell__text">
                          <span>{statusLabel(row.status)}</span>
                          {row.sources.length ? <span className="src-cell__src">{row.sources.map(sourceLabel).join(' · ')}</span> : null}
                        </span>
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="src-explainer__caption">{t('sources.explainer.matrix.caption')}</p>
        <p className="src-explainer__caption">{t('sources.explainer.perApp')}</p>
      </section>
    </div>
  );
}

/** "Veriler nereden gelir?" dialog (from the SDK guide, onboarding, the help menu and every sources panel). */
export function DataSourcesDialog() {
  const open = useUi((s) => s.dataSources);
  const t = useT();
  return (
    <Dialog
      open={open}
      onClose={ui.closeDataSources}
      title={t('sources.explainer.title')}
      description={t('sources.explainer.description')}
      icon={ShieldCheck}
      size="xl"
      autoFocusField={false}
      footer={
        <>
          <Button variant="ghost" icon={BookOpen} onClick={() => ui.openSdkGuide('flutter', 'setup')}>
            {t('shell.sdk.title')}
          </Button>
          <Button variant="primary" onClick={ui.closeDataSources}>
            {t('common.done')}
          </Button>
        </>
      }
    >
      {open ? <DataSourcesExplainer /> : null}
    </Dialog>
  );
}
