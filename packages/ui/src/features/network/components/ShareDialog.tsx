import { useMemo } from 'react';
import { Copy, FileDown, Share2 } from 'lucide-react';
import type { NetworkEntry } from '@durbun/protocol';
import { useApp, useDevice, useMocks } from '../../../data';
import { Button, Callout, CodeView, Dialog, SlackButton, Spinner, Toggle, copyText, downloadText, formatBytes, toast, usePersistentState, useShortcut } from '../../../components';
import { useLanguage, useT } from '../../../i18n';
import { ruleLabel } from '../../mocks/model/rules';
import { useNetworkDetail } from '../detailCache';
import { DEFAULT_SHARE_OPTIONS, buildShareReport, type ShareOptions } from '../model/shareReport';
import { shareFileName, shareInputFor, shareLabels } from '../share';

/** "Share request": the share report (same text as the in-app Flutter panel) with its options, a preview, Copy and Send to Slack. */
export function ShareDialog({ entry, gone, onClose }: { entry: NetworkEntry; gone?: boolean; onClose: () => void }) {
  const t = useT();
  const lang = useLanguage();
  const app = useApp(entry.appId);
  const device = useDevice(entry.deviceId);
  const rule = useMocks((s) => (entry.mockRuleId ? s.rules.find((r) => r.id === entry.mockRuleId) : undefined));
  const hasBodies = entry.hasRequestBody || entry.hasResponseBody;
  const { detail, loading, error } = useNetworkDetail(gone || !hasBodies ? null : entry);
  const [saved, setSaved] = usePersistentState<ShareOptions>('network.shareOptions', DEFAULT_SHARE_OPTIONS);
  const options: ShareOptions = { ...DEFAULT_SHARE_OPTIONS, ...saved };
  const set = (patch: Partial<ShareOptions>) => setSaved({ ...options, ...patch });

  const ruleName = rule ? ruleLabel(rule) : undefined;
  const report = useMemo(
    () => buildShareReport(shareInputFor(entry, detail, { app, device, rule: ruleName }), { mask: options.mask, bodies: options.bodies, curl: options.curl }, shareLabels(lang)),
    [entry, detail, app, device, ruleName, options.mask, options.bodies, options.curl, lang],
  );
  const size = useMemo(() => new TextEncoder().encode(report).length, [report]);
  // The bodies are on their way: copying now would say "not captured".
  const waiting = options.bodies && hasBodies && !gone && loading && !detail;
  const unavailable = options.bodies && hasBodies && (gone || (!!error && !detail));

  const copy = async () => {
    if (waiting) return;
    if (await copyText(report)) {
      toast.success(t('network.share.copied'));
      onClose();
    } else {
      toast.error(t('network.toast.copyFailed'), { action: { label: t('network.toast.copyAgain'), onClick: () => void copyText(report) }, duration: 10_000 });
    }
  };
  useShortcut('Mod+Enter', () => void copy(), { allowInModal: true, allowInInputs: true });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      icon={Share2}
      title={t('network.share.title')}
      description={t('network.share.description')}
      footer={
        <>
          <span className="net-dim net-small grow tnum">{t('network.share.size', { size: formatBytes(size) })}</span>
          <Button variant="ghost" icon={FileDown} disabled={waiting} onClick={() => downloadText(report, shareFileName(entry), 'text/markdown;charset=utf-8')}>
            {t('network.share.save')}
          </Button>
          <SlackButton report={report} disabled={waiting} onSent={onClose} onConnect={onClose} />
          <Button variant="primary" icon={Copy} disabled={waiting} onClick={() => void copy()} kbd="Mod+Enter">
            {t('network.share.copy')}
          </Button>
        </>
      }
    >
      <div className="net-share">
        <div className="net-share__options" role="group" aria-label={t('network.share.options')}>
          <Toggle checked={options.mask} onChange={(v) => set({ mask: v })} label={t('network.share.mask')} description={t('network.share.maskHint')} size="sm" />
          <Toggle checked={options.bodies} onChange={(v) => set({ bodies: v })} label={t('network.share.bodies')} size="sm" />
          <Toggle checked={options.curl} onChange={(v) => set({ curl: v })} label={t('network.share.curl')} size="sm" />
        </div>
        {waiting ? (
          <div className="net-loading">
            <Spinner size={14} /> {t('network.share.loading')}
          </div>
        ) : unavailable ? (
          <Callout tone="warn" compact>
            {t('network.share.bodiesUnavailable')}
          </Callout>
        ) : null}
        <div className="net-share__label">{t('network.share.preview')}</div>
        <CodeView code={report} language="plain" lineNumbers={false} defaultWrap toolbar={false} maxHeight="min(52vh, 560px)" aria-label={t('network.share.preview')} />
      </div>
    </Dialog>
  );
}
