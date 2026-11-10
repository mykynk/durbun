import { useMemo } from 'react';
import { Copy, FileDown, Share2 } from 'lucide-react';
import type { LogEntry } from '@durbun/protocol';
import { useApp, useDevice } from '../../../data';
import { Button, CodeView, Dialog, SlackButton, copyText, downloadText, formatBytes, toast, useShortcut } from '../../../components';
import { translate, useLanguage, useT, type Lang } from '../../../i18n';
import { shareAppLabel, shareDeviceLabel } from '../../network/share';
import { buildLogReport, type LogShareLabels } from '../model/shareReport';
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

/** "Share log line": the log report with a preview, Copy, Save and Send to Slack. */
export function ShareDialog({ entry: e, onClose }: { entry: LogEntry; onClose: () => void }) {
  const t = useT();
  const lang = useLanguage();
  const app = useApp(e.appId);
  const device = useDevice(e.deviceId);

  const report = useMemo(() => {
    const kindKey = e.kind ? KIND_KEYS[e.kind] : undefined;
    const process = [e.process, e.pid].filter((x) => x !== undefined && x !== '').join(' ');
    return buildLogReport(
      {
        level: e.level,
        tag: e.tag || undefined,
        kind: kindKey ? translate(lang, kindKey) : undefined,
        ts: e.ts,
        app: shareAppLabel(app),
        device: shareDeviceLabel(device),
        process: process || undefined,
        message: displayText(e),
        // The app's own structured data; device and system lines carry Dürbün's internal fields there.
        data: e.source === 'app' ? e.data : undefined,
        error: e.error,
      },
      logShareLabels(lang),
    );
  }, [e, app, device, lang]);
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

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      icon={Share2}
      title={t('logs.share.title')}
      description={t('logs.share.description')}
      footer={
        <>
          <span className="muted text-sm grow tnum">{t('logs.share.size', { size: formatBytes(size) })}</span>
          <Button variant="ghost" icon={FileDown} onClick={() => downloadText(report, `durbun-log-${e.id}.md`, 'text/markdown;charset=utf-8')}>
            {t('logs.share.save')}
          </Button>
          <SlackButton report={report} onSent={onClose} onConnect={onClose} />
          <Button variant="primary" icon={Copy} onClick={() => void copy()} kbd="Mod+Enter">
            {t('logs.share.copy')}
          </Button>
        </>
      }
    >
      <CodeView code={report} language="plain" lineNumbers={false} defaultWrap toolbar={false} maxHeight="min(56vh, 600px)" aria-label={t('logs.share.preview')} />
    </Dialog>
  );
}
