import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { Check, FileUp, X } from 'lucide-react';
import type { AppSession, MockRule } from '@durbun/protocol';
import { useHub } from '../../../data';
import { Button, Callout, Dialog, MethodBadge, SdkBadge, SegmentedControl, Tooltip } from '../../../components';
import { useLanguage, useT } from '../../../i18n';
import { actionSummary, ruleLabel, type ImportIssue } from '../model/rules';

/** "Pati (Flutter) ✓ mock destekli · Pati (Dart VM) ✗" for the connected apps in scope. */
export function CapabilityHints({ apps }: { apps: readonly AppSession[] }) {
  const t = useT();
  const deviceSig = useHub((s) =>
    Object.values(s.devices)
      .map((d) => `${d.id}\u0001${d.name}`)
      .join('\u0002'),
  );
  const deviceNames = useMemo(() => new Map(deviceSig ? deviceSig.split('\u0002').map((x) => x.split('\u0001') as [string, string]) : []), [deviceSig]);
  const connected = useMemo(() => {
    const seen = new Set<string>();
    const out: AppSession[] = [];
    for (const a of apps) {
      if (!a.connected) continue;
      const key = `${a.deviceId}|${a.app.id}|${a.sdk.platform}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    return out;
  }, [apps]);
  const unsupported = connected.some((a) => !a.capabilities.includes('mocks'));
  return (
    <div className="mk-caps" aria-label={t('mocks.caps.title')} role="group">
      <span className="mk-caps__title">{t('mocks.caps.title')}</span>
      {connected.length === 0 ? <span className="mk-caps__none">{t('mocks.caps.none')}</span> : null}
      {connected.map((a) => {
        const ok = a.capabilities.includes('mocks');
        return (
          <Tooltip key={a.id} content={ok ? `${a.app.id}` : t('mocks.caps.unsupportedHint')}>
            <span className={clsx('mk-cap', ok ? 'is-ok' : 'is-no')} tabIndex={0}>
              <span className="mk-cap__name">{a.app.name}</span>
              <SdkBadge platform={a.sdk.platform} />
              {deviceNames.get(a.deviceId) ? <span className="mk-cap__dev">{deviceNames.get(a.deviceId)}</span> : null}
              {ok ? <Check size={12} aria-hidden /> : <X size={12} aria-hidden />}
              <span className="mk-cap__state">{ok ? t('mocks.caps.supported') : t('mocks.caps.unsupported')}</span>
            </span>
          </Tooltip>
        );
      })}
      {unsupported ? <span className="mk-caps__hint">{t('mocks.caps.unsupportedHint')}</span> : null}
    </div>
  );
}

export interface PendingImport {
  file: string;
  rules: MockRule[];
  issues: ImportIssue[];
}

export function ImportDialog({ pending, existing, onClose, onConfirm }: { pending: PendingImport; existing: number; onClose: () => void; onConfirm: (mode: 'append' | 'replace') => void }) {
  const t = useT();
  const lang = useLanguage();
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const issueText = (i: ImportIssue) => (i.index > 0 ? t('mocks.io.issueRow', { index: i.index, problem: t(`mocks.io.issues.${i.code}`) }) : t(`mocks.io.issues.${i.code}`));
  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      icon={FileUp}
      title={t('mocks.io.importTitle')}
      description={t('mocks.io.importDescription', { file: pending.file })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('mocks.io.cancel')}
          </Button>
          <Button variant={mode === 'replace' ? 'danger' : 'primary'} disabled={pending.rules.length === 0} onClick={() => onConfirm(mode)}>
            {t('mocks.io.confirm')}
          </Button>
        </>
      }
    >
      <div className="mk-import">
        <p className="mk-import__found">{t('mocks.io.found', { count: pending.rules.length })}</p>
        {pending.rules.length > 0 ? (
          <ul className="mk-import__list">
            {pending.rules.slice(0, 12).map((r) => (
              <li key={r.id}>
                {r.method === '*' ? <span className="mk-anymethod">*</span> : <MethodBadge method={r.method} />}
                <span className="truncate">{ruleLabel(r)}</span>
                <span className="mk-import__sum">{actionSummary(r.action, t, lang)}</span>
              </li>
            ))}
            {pending.rules.length > 12 ? <li className="mk-hint">+{pending.rules.length - 12}</li> : null}
          </ul>
        ) : null}
        {pending.issues.length > 0 ? (
          <Callout tone="warn" compact title={pending.rules.length > 0 ? t('mocks.io.skipped', { count: pending.issues.length }) : undefined}>
            <ul className="mk-import__issues">
              {pending.issues.slice(0, 8).map((i, k) => (
                <li key={k}>{issueText(i)}</li>
              ))}
            </ul>
          </Callout>
        ) : null}
        {pending.rules.length > 0 && existing > 0 ? (
          <>
            <SegmentedControl
              value={mode}
              onChange={setMode}
              options={[
                { value: 'append', label: t('mocks.io.append') },
                { value: 'replace', label: t('mocks.io.replace') },
              ]}
              aria-label={t('mocks.io.mode')}
            />
            {mode === 'replace' ? <p className="mk-warn">{t('mocks.io.replaceWarn', { count: existing })}</p> : null}
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
