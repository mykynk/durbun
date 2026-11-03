import { useMemo, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, ChevronUp, Copy, Download, ExternalLink, Funnel, FunnelX, History, LocateFixed, X } from 'lucide-react';
import type { DeviceInfo, LogEntry, NetworkEntry } from '@durbun/protocol';
import { Button, CodeView, CopyButton, IconButton, JsonTree, LevelBadge, MethodBadge, StatusBadge, copyText, formatBytes, formatClock, formatDateTime, formatDuration, toast } from '../../../components';
import { networkStore, useHub, useNetworkVersion } from '../../../data';
import { deviceDisplayName, t } from '../../../i18n';
import { analyzeEntry } from '../model/analyze';
import { formatTxtEntry, formatTxtRow } from '../model/export';
import { parseStack } from '../model/frames';
import type { QueryField } from '../model/queryEdit';
import { flapSummary, systemText } from '../model/systemText';
import { isPreviousLaunch, type LogRow } from '../model/types';
import { crashForeground, crashedBuildOf, entryClock, isNativeTombstone, isWholeSecond, recordUnsymbolicated } from '../model/records';
import type { ExplainSource } from '../../../data';
import { entryOrigin, entrySourceText, isDeviceCrashRecord, sourceHint } from '../../../sources/text';
import { StackLines, errorHeadParts, type RowDisplay } from './LogRow';
import { downloadUrl } from '../../../lib/download';

export interface DetailPanelProps {
  entry: LogEntry;
  row?: LogRow;
  /** Position in the list (-1 when the row is not visible). */
  index: number;
  total: number;
  d: RowDisplay;
  onClose(): void;
  onPrev(): void;
  onNext(): void;
  onFilter(field: QueryField, value: string | number, exclude: boolean): void;
  onShowInContext(entryId: number): void;
  onOpenNetwork(netId: string): void;
}

/** Text used for copies/exports of any row kind (system lines localized, network rows summarized). */
export function displayText(e: LogEntry): string {
  if (e.source === 'system' && (e.kind === 'lifecycle' || e.kind === 'marker' || e.code)) return systemText(e);
  if (e.kind === 'network' && e.netId) {
    const n = networkStore.get(e.netId);
    if (n) {
      const parts = [`→ ${n.method} ${n.url}`];
      if (typeof n.status === 'number') parts.push(String(n.status));
      if (n.state === 'failed') parts.push(n.error ? `failed: ${n.error}` : 'failed');
      if (typeof n.duration === 'number') parts.push(formatDuration(n.duration));
      if (typeof n.responseBodySize === 'number') parts.push(formatBytes(n.responseBodySize));
      return parts.join(' · ');
    }
  }
  return e.message;
}

export function entryAsLine(e: LogEntry, repeat = 1): string {
  return formatTxtEntry(e, { text: displayText }, repeat);
}

/** "Copy as line" of a row: ×N for a folded row, one line per event for a merged connection row. */
export function rowAsLines(row: LogRow): string {
  return formatTxtRow(row, { text: displayText });
}

/** "Android 15", "iOS 27.2" (other platforms report their own, e.g. "macOS 27.2"). */
function osLabel(d: Pick<DeviceInfo, 'platform' | 'osVersion'>): string {
  const v = d.osVersion ?? '';
  return d.platform === 'android' ? `Android ${v}` : d.platform === 'ios' && !/^i(Phone )?OS/i.test(v) ? `iOS ${v}` : v;
}

function preciseTime(e: Pick<LogEntry, 'ts' | 'origin' | 'data'>): string {
  return `${formatDateTime(e.ts, { seconds: false })}:${entryClock(e).slice(6)}`;
}

const KIND_QUERY: Partial<Record<NonNullable<LogEntry['kind']>, string>> = {
  crash: 'crash',
  anr: 'anr',
  'flutter-error': 'flutter',
  event: 'event',
  network: 'network',
  marker: 'marker',
};

/**
 * Copy of an iOS crash report the server keeps (`data.reportUrl`, SPEC §10.3 convention): only its own
 * `/api/files/crash/<udid>/<name>.ips` path, never for imported recordings (the file stayed on the other Mac).
 */
export function crashReportDownload(e: Pick<LogEntry, 'data' | 'deviceId'>): { url: string; fileName: string } | undefined {
  const d = e.data as { reportUrl?: unknown } | null | undefined;
  const url = d && typeof d === 'object' && typeof d.reportUrl === 'string' ? d.reportUrl : undefined;
  if (!url || !url.startsWith('/api/files/crash/') || e.deviceId.startsWith('import:')) return undefined;
  const last = url.slice(url.lastIndexOf('/') + 1);
  let fileName = last;
  try {
    fileName = decodeURIComponent(last);
  } catch {
    // keep the encoded name
  }
  return { url, fileName: fileName || 'crash.ips' };
}

/** Log origin → the source whose one-line description explains it (tooltip on the metadata row). */
const ORIGIN_HINT: Partial<Record<string, ExplainSource>> = {
  logcat: 'logcat',
  idevicesyslog: 'idevicesyslog',
  'simctl-log': 'simctl-log',
  sdk: 'sdk',
  'vm-service': 'vm-service',
  dropbox: 'dropbox',
  'crash-report': 'crash-report',
  demo: 'demo',
  import: 'import',
};

interface MetaRow {
  key: string;
  label: string;
  value: ReactNode;
  copy?: string;
  filter?: { field: QueryField; value: string | number; exclude?: boolean };
}

export function DetailPanel({ entry: e, row, index, total, d, onClose, onPrev, onNext, onFilter, onShowInContext, onOpenNetwork }: DetailPanelProps) {
  const a = analyzeEntry(e);
  const devices = useHub((s) => s.devices);
  const apps = useHub((s) => s.apps);
  useNetworkVersion({ enabled: e.kind === 'network' });
  const net: NetworkEntry | undefined = e.kind === 'network' && e.netId ? networkStore.get(e.netId) : undefined;
  const app = e.appId ? apps[e.appId] : undefined;
  const device = devices[e.deviceId];
  const identity = d.identity(e);

  const kindLabel = e.kind === 'crash' ? t('logs.kind.crash') : e.kind === 'anr' ? t('logs.kind.anr') : e.kind === 'flutter-error' ? t('logs.kind.flutterError') : e.kind ? t(`logs.kind.${e.kind}`) : t('logs.kind.text');
  const isSystem = e.source === 'system';
  const message = isSystem ? systemText(e) : e.message;

  const messageStack = useMemo(() => {
    if (isSystem || e.kind === 'network') return null;
    const parsed = parseStack(e.message, identity);
    return parsed.frames >= 2 ? parsed : null;
  }, [e, isSystem, identity]);
  const errorStack = useMemo(() => (e.error?.stack ? parseStack(e.error.stack, identity) : null), [e, identity]);

  const meta: MetaRow[] = [];
  const seconds = isWholeSecond(e);
  meta.push({
    key: 'time',
    label: t('logs.detail.fields.time'),
    value: seconds ? <span title={t('logs.detail.secondsOnly')}>{preciseTime(e)}</span> : preciseTime(e),
    copy: new Date(e.ts).toISOString(),
  });
  meta.push({ key: 'level', label: t('logs.detail.fields.level'), value: <LevelBadge level={e.level} variant="text" />, copy: e.level, filter: { field: 'level', value: e.level } });
  const origin = entryOrigin(e);
  const originHint = origin && ORIGIN_HINT[origin] ? sourceHint(ORIGIN_HINT[origin]!) : undefined;
  meta.push({
    key: 'source',
    label: t('logs.detail.fields.source'),
    value: <span title={originHint}>{entrySourceText(e)}</span>,
    copy: origin ?? e.source,
    filter: { field: 'source', value: e.source },
  });
  const record = isDeviceCrashRecord(e);
  // The device's own record: this row itself, or the record the server matched to this live crash line.
  const rec = record ? e : row?.rec && row.rec.id !== e.id && row.id === e.id ? row.rec : undefined;
  const report = rec ? crashReportDownload(rec) : undefined;
  const unsymbolicated = !!rec && recordUnsymbolicated(rec);
  const built = rec ? crashedBuildOf(rec) : undefined;
  const foreground = rec ? crashForeground(rec) : undefined;
  if (record) {
    const notes = [t('sources.crash.fromDevice')];
    if (isPreviousLaunch(e)) notes.push(t('logs.row.beforeWatching'));
    if (unsymbolicated) notes.push(t('sources.crash.unsymbolicated'));
    meta.push({ key: 'record', label: t('sources.crash.recordLabel'), value: <span title={t('sources.crash.fromDeviceTip')}>{notes.join(' · ')}</span>, copy: notes.join(' · ') });
  }
  if (built) meta.push({ key: 'build', label: t('logs.detail.fields.crashedBuild'), value: built, copy: built });
  if (foreground !== undefined) meta.push({ key: 'fg', label: t('logs.detail.fields.foreground'), value: foreground ? t('logs.detail.foregroundYes') : t('logs.detail.foregroundNo') });
  meta.push({ key: 'kind', label: t('logs.detail.fields.kind'), value: kindLabel, copy: e.kind ?? 'text', filter: e.kind && KIND_QUERY[e.kind] ? { field: 'is', value: KIND_QUERY[e.kind]! } : undefined });
  if (e.tag) meta.push({ key: 'tag', label: t('logs.detail.fields.tag'), value: e.tag, copy: e.tag, filter: { field: 'tag', value: e.tag } });
  if (e.process) meta.push({ key: 'process', label: t('logs.detail.fields.process'), value: e.process, copy: e.process, filter: { field: 'process', value: e.process } });
  if (e.pid !== undefined || e.tid !== undefined)
    meta.push({
      key: 'pid',
      label: t('logs.detail.fields.pid'),
      value: `${e.pid ?? '—'} / ${e.tid ?? '—'}`,
      copy: String(e.pid ?? e.tid ?? ''),
      filter: e.pid !== undefined ? { field: 'pid', value: e.pid } : undefined,
    });
  meta.push({ key: 'device', label: t('logs.detail.fields.device'), value: device ? `${deviceDisplayName(device)}${device.osVersion ? ` · ${osLabel(device)}` : ''}` : e.deviceId || '—', copy: e.deviceId });
  if (app)
    meta.push({
      key: 'app',
      label: t('logs.detail.fields.app'),
      value: `${app.app.name}${app.app.version ? ` ${app.app.version}` : ''} · ${app.app.id}`,
      copy: app.app.id,
      filter: { field: 'app', value: app.app.id },
    });
  if (app) meta.push({ key: 'sdk', label: t('logs.detail.fields.sdk'), value: `${app.sdk.name} ${app.sdk.version} · ${app.sdk.platform}`, copy: `${app.sdk.name} ${app.sdk.version}` });
  if (e.subsystem) meta.push({ key: 'subsystem', label: t('logs.detail.fields.subsystem'), value: e.subsystem, copy: e.subsystem });
  if (e.category) meta.push({ key: 'category', label: t('logs.detail.fields.category'), value: e.category, copy: e.category });
  if (e.code) meta.push({ key: 'code', label: t('logs.detail.fields.code'), value: e.code, copy: e.code });
  if (e.netId) meta.push({ key: 'net', label: t('logs.detail.fields.netId'), value: e.netId, copy: e.netId });
  if (row && row.n > 1)
    meta.push({
      key: 'repeat',
      label: t('logs.detail.fields.repeat'),
      value: t('logs.detail.repeat', { count: row.n, first: formatClock(row.e.ts), last: formatClock((row.last ?? row.e).ts) }),
    });
  meta.push({ key: 'id', label: t('logs.detail.fields.id'), value: String(e.id), copy: String(e.id) });

  const copy = async (text: string) => {
    const ok = await copyText(text);
    if (ok) toast.success(t('common.copied'));
    else toast.error(t('common.copyFailed'));
  };

  const lines = message.split('\n').length;
  const errHead = e.error ? errorHeadParts(e.error) : undefined;
  const crashedText = built && a.crash ? t(a.crash.kind === 'anr' ? 'logs.row.anrInBuild' : 'logs.row.crashedInBuild', { build: built }) : undefined;
  const flap = row?.id === e.id ? row.flap : undefined;

  return (
    <aside className="lg-detail" aria-label={t('logs.detail.title')}>
      <header className="lg-detail__head">
        <LevelBadge level={e.level} />
        <span className="lg-detail__time tnum" title={seconds ? `${new Date(e.ts).toISOString()} · ${t('logs.detail.secondsOnly')}` : new Date(e.ts).toISOString()}>
          {entryClock(e)}
        </span>
        {e.kind && e.kind !== 'text' ? <span className="lg-detail__kind">{kindLabel}</span> : e.tag ? <span className="lg-detail__kind mono">{e.tag}</span> : null}
        <span className="grow" />
        <span className="lg-detail__pos tnum">{index >= 0 ? `${index + 1} / ${total}` : ''}</span>
        <IconButton icon={ChevronUp} label={t('logs.detail.prev')} shortcut="K" size="sm" disabled={index <= 0} onClick={onPrev} />
        <IconButton icon={ChevronDown} label={t('logs.detail.next')} shortcut="J" size="sm" disabled={index < 0 || index >= total - 1} onClick={onNext} />
        <IconButton icon={X} label={t('logs.detail.close')} shortcut="Escape" size="sm" onClick={onClose} />
      </header>

      <div className="lg-detail__body">
        {a.crash ? (
          <section className={clsx('lg-detail__crash', `lg-detail__crash--${a.crash.kind}`)}>
            <div className="lg-detail__crash-title selectable">{a.crash.title}</div>
            <div className="lg-detail__crash-meta">
              {d.appName(e) ?? e.process ?? e.tag}
              {crashedText ? ` · ${crashedText}` : ''}
              {foreground ? ` · ${t('logs.detail.wasForeground')}` : ''}
              {a.crash.detail ? ` · ${a.crash.detail}` : ''}
            </div>
            {a.crash.previousLaunch ? (
              <div className="lg-prev" title={record ? t('sources.crash.previousLaunchTip') : t('logs.row.previousLaunchTip')}>
                <History size={12} aria-hidden />
                {record ? t('logs.row.beforeWatching') : t('logs.row.previousLaunch')} · {preciseTime(e)}
              </div>
            ) : null}
          </section>
        ) : null}

        {rec && (report || unsymbolicated || !record) ? (
          <section className="lg-detail__sec lg-detail__record">
            {!record ? <p className="lg-detail__symb">{t('logs.detail.recordOfLive', { origin: entryOrigin(rec) === 'crash-report' ? '.ips' : 'dropbox' })}</p> : null}
            {unsymbolicated ? (
              <p className="lg-detail__symb">
                <strong>{t('sources.crash.symbolicateTitle')}.</strong> {isNativeTombstone(rec) ? t('logs.detail.symbolicateNative') : t('sources.crash.symbolicate')}
              </p>
            ) : null}
            {report ? (
              <Button size="sm" icon={Download} title={t('sources.crash.downloadTip')} onClick={() => downloadUrl(report.url, report.fileName)}>
                {t('sources.crash.download')}
              </Button>
            ) : null}
          </section>
        ) : null}

        {net ? (
          <section className="lg-detail__sec">
            <h3 className="lg-detail__h">{t('logs.detail.network')}</h3>
            <div className="lg-detail__net">
              <MethodBadge method={net.method} />
              <StatusBadge status={net.status} state={net.state} error={net.error} statusText={net.statusText} />
              <span className="lg-detail__net-url selectable mono">{net.url}</span>
            </div>
            <div className="lg-detail__net-meta tnum">
              {typeof net.duration === 'number' ? <span>{formatDuration(net.duration)}</span> : null}
              {typeof net.responseBodySize === 'number' ? <span>{formatBytes(net.responseBodySize)}</span> : null}
              {net.mocked ? <span className="lg-net-mock">{t('logs.net.mocked')}</span> : null}
              {net.error ? <span className="lg-net-error">{net.error}</span> : null}
            </div>
            <Button size="sm" icon={ExternalLink} onClick={() => onOpenNetwork(net.id)}>
              {t('logs.net.open')}
            </Button>
          </section>
        ) : null}

        {flap ? (
          <section className="lg-detail__sec">
            <h3 className="lg-detail__h">{t('logs.flap.title')}</h3>
            <p className="lg-detail__symb">{flapSummary(flap.events, d.deviceName?.(e.deviceId) ?? d.device?.(e)?.name, d.lang).text}</p>
            <div className="lg-flap lg-flap--detail">
              {flap.events.map((ev) => (
                <div key={ev.id} className="lg-flap__ev">
                  <span className="lg-flap__time tnum">{formatClock(ev.ts, { ms: false })}</span>
                  <span>{systemText(ev)}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="lg-detail__sec">
          <div className="lg-detail__sechead">
            <h3 className="lg-detail__h">{t('logs.detail.message')}</h3>
            <CopyButton size="xs" value={message} label={t('logs.detail.copyMessage')} />
          </div>
          {lines > 600 ? (
            <CodeView code={message} language="plain" maxHeight={420} lineNumbers toolbar={false} defaultWrap />
          ) : messageStack ? (
            <div className="lg-detail__msg lg-detail__msg--stack selectable">
              <StackLines lines={messageStack.lines} hl={d.hl} limit={2000} />
            </div>
          ) : (
            <pre className="lg-detail__msg selectable">{message}</pre>
          )}
        </section>

        {e.error && (e.error.message || e.error.stack) ? (
          <section className="lg-detail__sec">
            <div className="lg-detail__sechead">
              <h3 className="lg-detail__h">{t('logs.detail.error')}</h3>
              {e.error.stack ? <CopyButton size="xs" value={e.error.stack} label={t('logs.detail.copyStack')} /> : null}
            </div>
            {errHead && (errHead.type || errHead.rest) ? (
              <div className="lg-detail__errhead selectable mono">
                {errHead.type ? <span className="lg-detail__errtype">{errHead.type}</span> : null}
                {errHead.rest ? <span>{errHead.rest}</span> : null}
              </div>
            ) : null}
            {errorStack ? (
              <div className="lg-detail__msg lg-detail__msg--stack selectable">
                <StackLines lines={errorStack.lines} hl={d.hl} limit={2000} />
              </div>
            ) : null}
          </section>
        ) : null}

        {a.json ? (
          <section className="lg-detail__sec">
            <div className="lg-detail__sechead">
              <h3 className="lg-detail__h">{e.kind === 'event' ? t('logs.detail.props') : a.json.fromData ? t('logs.detail.data') : t('logs.detail.payload')}</h3>
            </div>
            <div className="lg-detail__json">
              <JsonTree data={a.json.value} rootLabel={e.kind === 'event' ? 'props' : 'data'} defaultExpandDepth={2} toolbar />
            </div>
          </section>
        ) : e.kind === 'event' && e.data && typeof e.data === 'object' ? (
          <section className="lg-detail__sec">
            <h3 className="lg-detail__h">{t('logs.detail.props')}</h3>
            <div className="lg-detail__json">
              <JsonTree data={e.data} rootLabel="props" defaultExpandDepth={2} toolbar />
            </div>
          </section>
        ) : null}

        <section className="lg-detail__sec">
          <h3 className="lg-detail__h">{t('logs.detail.meta')}</h3>
          <div className="lg-kv" role="table" aria-label={t('logs.detail.meta')}>
            {meta.map((m) => (
              <div key={m.key} className="lg-kv__row" role="row">
                <div className="lg-kv__key" role="rowheader">
                  {m.label}
                </div>
                <div className="lg-kv__val selectable" role="cell">
                  {m.value}
                </div>
                <div className="lg-kv__acts" role="cell">
                  {m.filter ? (
                    <>
                      <IconButton icon={Funnel} label={t('logs.detail.filter')} size="xs" onClick={() => onFilter(m.filter!.field, m.filter!.value, false)} />
                      <IconButton icon={FunnelX} label={t('logs.detail.exclude')} size="xs" onClick={() => onFilter(m.filter!.field, m.filter!.value, true)} />
                    </>
                  ) : null}
                  {m.copy ? <CopyButton size="xs" value={m.copy} label={t('common.copyValue')} /> : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <footer className="lg-detail__foot">
        <Button size="sm" variant="primary" icon={LocateFixed} title={t('logs.detail.showInContextTip')} onClick={() => onShowInContext(e.id)}>
          {t('logs.detail.showInContext')}
        </Button>
        <Button size="sm" icon={Copy} onClick={() => void copy(row?.id === e.id ? rowAsLines(row) : entryAsLine(e))}>
          {t('logs.detail.copyLine')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copy(JSON.stringify(e, null, 2))}>
          {t('logs.detail.copyJson')}
        </Button>
      </footer>
    </aside>
  );
}
