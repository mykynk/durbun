import { useMemo } from 'react';
import { Bug, Copy, FileDown, Share2 } from 'lucide-react';
import type { AppSession, DeviceApp, DeviceInfo, LogEntry } from '@durbun/protocol';
import { useDevice, useHub } from '../../../data';
import { Button, CodeView, Dialog, SlackButton, Toggle, copyText, downloadText, formatBytes, toast, usePersistentState, useShortcut } from '../../../components';
import { translate, useLanguage, useT, type Lang } from '../../../i18n';
import { shareAppLabel, shareDeviceLabel, shareInstallLabel } from '../../network/share';
import { deviceAppForEntry, sessionForEntry } from '../model/appOf';
import { buildLinesReport, buildLogReport, type LogShareLabels } from '../model/shareReport';
import { LogMasker } from '../model/maskLog';
import { formatTxtEntry } from '../model/export';
import { bugReport } from '../../report/store';
import { displayText } from './DetailPanel';

const KIND_KEYS: Partial<Record<string, string>> = { crash: 'logs.kind.crash', anr: 'logs.kind.anr', 'flutter-error': 'logs.kind.flutterError' };

/** Report labels in [lang] (the report follows the UI language). */
export function logShareLabels(lang: Lang): LogShareLabels {
  const r = (key: string, params?: Record<string, string | number>) => translate(lang, `logs.share.report.${key}`, params);
  return {
    time: r('time'),
    app: r('app'),
    device: r('device'),
    process: r('process'),
    message: r('message'),
    data: r('data'),
    error: r('error'),
    stack: r('stack'),
    more: (count) => r('more', { count }),
  };
}

/**
 * The share report of one line in [lang] (the log Share dialog, and the moment of a bug report). `text` gives the
 * message (a bug report masks the URLs of network rows). With a `masker`, secret-looking values of the message,
 * the data and the error are masked (it counts them).
 */
export function logShareReport(
  e: LogEntry,
  context: { app?: AppSession; deviceApp?: DeviceApp; device?: DeviceInfo },
  lang: Lang,
  text: (e: LogEntry) => string = displayText,
  masker?: LogMasker,
): string {
  const { app, deviceApp, device } = context;
  const kindKey = e.kind ? KIND_KEYS[e.kind] : undefined;
  const process = [e.process, e.pid].filter((x) => x !== undefined && x !== '').join(' ');
  // The app's own structured data; device and system lines carry Dürbün's internal fields there.
  const data = e.source === 'app' ? e.data : undefined;
  return buildLogReport(
    {
      level: e.level,
      tag: e.tag || undefined,
      kind: kindKey ? translate(lang, kindKey) : undefined,
      ts: e.ts,
      app: shareAppLabel(app, deviceApp, shareInstallLabel(deviceApp, app, device)),
      device: shareDeviceLabel(device),
      process: process || undefined,
      message: masker ? masker.text(text(e)) : text(e),
      data: masker && data !== undefined ? masker.data(data) : data,
      error: masker ? masker.error(e.error) : e.error,
    },
    logShareLabels(lang),
  );
}

export interface LinesShareContext {
  /** The scope the lines were picked in ("All devices", "Shop · Pixel 8"). */
  scope?: string;
  /** How the lines were picked, for the dialog's title ("Selected lines", "14:02:10 – 14:02:40"). */
  origin?: string;
}

/**
 * "Share log line" / "Share N log lines": the report with a preview, Copy, Save and Send to Slack. Secret-looking
 * values are masked by default (the request Share dialog does the same). One line gets the full report (message,
 * data, stack); several lines (a selection, a time range) go out as plain lines under a short head. "Report a
 * bug…" takes a line with its context (the window around it, requests, a screenshot).
 */
export function ShareDialog({ entries, context, onClose }: { entries: readonly LogEntry[]; context?: LinesShareContext; onClose: () => void }) {
  const t = useT();
  const lang = useLanguage();
  const first = entries[0]!;
  const single = entries.length === 1;
  const device = useDevice(first.deviceId);
  // Device lines (crash records of an SDK-less build) have no session: the app the device reports names the build.
  const apps = useHub((s) => s.apps);
  const deviceApps = useHub((s) => s.deviceApps);
  const devices = useHub((s) => s.devices);
  const [maskRaw, setMask] = usePersistentState<boolean>('logs.shareMask', true);
  const mask = maskRaw !== false;

  const { report, masked } = useMemo(() => {
    const masker = mask ? new LogMasker() : undefined;
    if (single) {
      const app = sessionForEntry(first, apps);
      const deviceApp = deviceAppForEntry(first, deviceApps, app);
      return { report: logShareReport(first, { app, deviceApp, device }, lang, displayText, masker), masked: masker?.count ?? 0 };
    }
    const text = (e: LogEntry) => (masker ? masker.text(displayText(e)) : displayText(e));
    // Plain lines print `message` itself; system and network lines go through `text`.
    const plain = (e: LogEntry) => e.kind !== 'network' && e.source !== 'system';
    const body = entries.map((e) => formatTxtEntry(masker ? { ...e, message: plain(e) ? masker.text(e.message) : e.message, error: masker.error(e.error) } : e, { text })).join('\n');
    const deviceIds = new Set(entries.map((e) => e.deviceId));
    const oneDevice = deviceIds.size === 1 ? devices[first.deviceId] : undefined;
    const sessions = new Set(entries.map((e) => sessionForEntry(e, apps)?.app.id ?? ''));
    const oneApp = sessions.size === 1 && !sessions.has('') ? sessionForEntry(first, apps) : undefined;
    let from = Infinity;
    let to = -Infinity;
    for (const e of entries) {
      if (e.ts < from) from = e.ts;
      if (e.ts > to) to = e.ts;
    }
    const r = (key: string, params?: Record<string, string | number>) => translate(lang, `logs.share.report.${key}`, params);
    const count = masker?.count ?? 0;
    const out = buildLinesReport(
      {
        title: r('linesTitle', { count: entries.length }),
        from,
        to,
        scope: context?.scope,
        app: oneApp ? shareAppLabel(oneApp, undefined, undefined) : undefined,
        device: shareDeviceLabel(oneDevice),
        text: body,
        maskedNote: count > 0 ? r('maskedNote') : undefined,
      },
      { range: r('range'), scope: r('scope'), app: r('app'), device: r('device'), more: (n) => r('more', { count: n }) },
    );
    return { report: out, masked: count };
  }, [entries, single, first, apps, deviceApps, devices, device, lang, mask, context?.scope]);
  const size = useMemo(() => new TextEncoder().encode(report).length, [report]);

  const copy = async () => {
    if (await copyText(report)) {
      toast.success(t('logs.share.copied'));
      onClose();
    } else {
      toast.error(t('common.copyFailed'));
    }
  };
  useShortcut('Mod+Enter', () => void copy(), { allowInModal: true, allowInInputs: true });

  const fileName = single ? `durbun-log-${first.id}.md` : `durbun-logs-${first.id}-${entries[entries.length - 1]!.id}.md`;
  const title = single ? t('logs.share.title') : t('logs.share.titleLines', { count: entries.length });
  const description = single ? t('logs.share.description') : [context?.origin, t('logs.share.descriptionLines')].filter(Boolean).join(' · ');

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      icon={Share2}
      title={title}
      description={description}
      footer={
        <>
          <Button
            variant="ghost"
            icon={Bug}
            title={t('report.openHint')}
            onClick={() => {
              onClose();
              bugReport.open({ kind: 'log', logId: single ? first.id : entries[entries.length - 1]!.id });
            }}
          >
            {t('report.openEllipsis')}
          </Button>
          <span className="muted text-sm grow tnum">{t('logs.share.size', { size: formatBytes(size) })}</span>
          <Button variant="ghost" icon={FileDown} onClick={() => downloadText(report, fileName, 'text/markdown;charset=utf-8')}>
            {t('logs.share.save')}
          </Button>
          <SlackButton report={report} onSent={onClose} onConnect={onClose} />
          <Button variant="primary" icon={Copy} onClick={() => void copy()} kbd="Mod+Enter">
            {t('logs.share.copy')}
          </Button>
        </>
      }
    >
      <div className="lg-share">
        <div className="lg-share__options">
          <Toggle checked={mask} onChange={(v) => setMask(v)} label={t('logs.share.mask')} description={t('logs.share.maskHint')} size="sm" />
          <span className="lg-share__masked muted text-sm tnum" role="status">
            {mask ? (masked > 0 ? t('logs.share.masked', { count: masked }) : t('logs.share.maskedNone')) : t('logs.share.maskOff')}
          </span>
        </div>
        <CodeView code={report} language="plain" lineNumbers={false} defaultWrap toolbar={false} maxHeight="min(52vh, 560px)" aria-label={t('logs.share.preview')} />
      </div>
    </Dialog>
  );
}
