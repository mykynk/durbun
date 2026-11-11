import './i18n';
import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { Archive, Check, KeyRound, Share2 } from 'lucide-react';
import type { PackageExportRequest, PackageKind } from '@durbun/protocol';
import { Button, Callout, Checkbox, Dialog, Input, SegmentedControl, downloadBlob, toast } from '../../components';
import { api, ui, useFlows, useMocks } from '../../data';
import { errorText, useT } from '../../i18n';
import { useEnvironments } from '../flows/model/envStore';
import { uiPrefsSnapshot } from './prefsSync';

/** Same minimum the server asks for the stored backup passphrase. */
export const MIN_PASSPHRASE = 8;

interface Include {
  mocks: boolean;
  environments: boolean;
  settings: boolean;
  uiPrefs: boolean;
  runs: boolean;
}

const SHARE_DEFAULTS: Include = { mocks: true, environments: true, settings: false, uiPrefs: false, runs: false };

/** "Share your setup" (chosen items, never secrets) and "Back up everything" (one file for a new Mac). */
export function ExportDialog({ open, mode: initialMode, flows: initialFlows, onClose }: { open: boolean; mode: PackageKind; flows?: string[]; onClose(): void }) {
  const t = useT();
  const summaries = useFlows((s) => s.summaries);
  // Rules a flow adds while it runs are not the user's own setup.
  const mockCount = useMocks((s) => s.rules.filter((r) => !r.id.startsWith('flow-')).length);
  // Unknown until loaded: the row stays usable meanwhile.
  const envCount = useEnvironments()?.environments.length;
  const [mode, setMode] = useState<PackageKind>(initialMode);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [flows, setFlows] = useState<Set<string>>(new Set());
  const [inc, setInc] = useState<Include>(SHARE_DEFAULTS);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setName('');
    setNote('');
    setFlows(new Set(initialFlows ?? summaries.map((f) => f.id)));
    setInc(initialFlows ? { ...SHARE_DEFAULTS, mocks: false } : SHARE_DEFAULTS);
    setPass('');
    setPass2('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const sorted = useMemo(() => [...summaries].sort((a, b) => a.name.localeCompare(b.name)), [summaries]);
  const share = mode === 'share';
  const passProblem = !share && pass ? (pass.length < MIN_PASSPHRASE ? t('transfer.export.passphraseShort', { min: MIN_PASSPHRASE }) : pass !== pass2 ? t('transfer.export.passphraseMismatch') : null) : null;
  const nothing = share && flows.size === 0 && !(inc.mocks && mockCount) && !(inc.environments && envCount !== 0) && !inc.settings && !inc.uiPrefs && !inc.runs;

  const request = (): PackageExportRequest => {
    const base = { name: name.trim() || undefined, note: note.trim() || undefined };
    if (share) {
      const all = flows.size === summaries.length && summaries.length > 0;
      return {
        ...base,
        kind: 'share',
        include: { flows: all ? 'all' : [...flows], mocks: inc.mocks, environments: inc.environments && envCount !== 0, settings: inc.settings, uiPrefs: inc.uiPrefs, runs: inc.runs },
        ...(inc.uiPrefs ? { uiPrefs: uiPrefsSnapshot() } : {}),
      };
    }
    return {
      ...base,
      kind: 'backup',
      include: { flows: 'all', mocks: true, environments: true, settings: true, uiPrefs: true, slack: true, runs: inc.runs },
      uiPrefs: uiPrefsSnapshot(),
      ...(pass ? { passphrase: pass } : {}),
    };
  };

  const save = async () => {
    if (nothing || passProblem) return;
    setBusy(true);
    try {
      const { blob, fileName } = await api.exportPackage(request());
      downloadBlob(blob, fileName);
      // The desktop asks where to save it and does not tell the page the answer: say it is ready, not saved.
      toast.success(t('transfer.export.ready', { name: fileName }), { description: t('transfer.export.readyHint') });
      onClose();
    } catch (err) {
      toast.error(t('transfer.export.failed'), { description: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof Include, v: boolean) => setInc((s) => ({ ...s, [k]: v }));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon={share ? Share2 : Archive}
      title={share ? t('transfer.export.titleShare') : t('transfer.export.titleBackup')}
      description={share ? t('transfer.export.descShare') : t('transfer.export.descBackup')}
      size="md"
      footer={
        <>
          {nothing ? <span className="tx-footnote">{t('transfer.export.nothing')}</span> : null}
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon={share ? Share2 : Archive} loading={busy} disabled={nothing || !!passProblem} onClick={() => void save()}>
            {t('transfer.export.save')}
          </Button>
        </>
      }
    >
      <div className="tx-export">
        <SegmentedControl
          value={mode}
          onChange={setMode}
          aria-label={t('transfer.export.mode.label')}
          options={[
            { value: 'share', label: t('transfer.export.mode.share') },
            { value: 'backup', label: t('transfer.export.mode.backup') },
          ]}
        />
        <div className="tx-pair">
          <label className="tx-field">
            <span className="tx-field__label">{t('transfer.export.name')}</span>
            <Input size="sm" value={name} maxLength={200} placeholder={t('transfer.export.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="tx-field">
            <span className="tx-field__label">{t('transfer.export.note')}</span>
            <Input size="sm" value={note} maxLength={2000} placeholder={t('transfer.export.notePlaceholder')} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>

        <section className="tx-section">
          <h3 className="tx-section__title">{t('transfer.export.what')}</h3>
          {share ? (
            <>
              <div className="tx-item">
                <Checkbox
                  checked={flows.size > 0 && flows.size === summaries.length}
                  indeterminate={flows.size > 0 && flows.size < summaries.length}
                  disabled={summaries.length === 0}
                  onChange={(c) => setFlows(new Set(c ? summaries.map((f) => f.id) : []))}
                  label={t('transfer.export.flows')}
                />
                <span className="tx-item__meta">{summaries.length ? t('transfer.export.flowsPicked', { count: flows.size, total: summaries.length }) : t('transfer.export.noFlows')}</span>
              </div>
              {sorted.length ? (
                <div className="tx-flowlist" role="group" aria-label={t('transfer.export.flows')}>
                  {sorted.map((f) => (
                    <Checkbox
                      key={f.id}
                      className="tx-flowlist__item"
                      checked={flows.has(f.id)}
                      onChange={(c) =>
                        setFlows((s) => {
                          const next = new Set(s);
                          if (c) next.add(f.id);
                          else next.delete(f.id);
                          return next;
                        })
                      }
                      label={
                        <span className="tx-flowlist__label">
                          <span className="tx-flowlist__name">{f.name}</span>
                          <code className="tx-flowlist__id">{f.id}</code>
                        </span>
                      }
                    />
                  ))}
                </div>
              ) : null}
              {sorted.length ? <p className="tx-hint">{t('transfer.export.flowsHint')}</p> : null}
              <ItemRow checked={inc.mocks && mockCount > 0} disabled={mockCount === 0} onChange={(v) => set('mocks', v)} label={t('transfer.export.mocks')} meta={t('transfer.export.mocksCount', { count: mockCount })} />
              <ItemRow
                checked={inc.environments && envCount !== 0}
                disabled={envCount === 0}
                onChange={(v) => set('environments', v)}
                label={t('transfer.export.environments')}
                {...(envCount !== undefined ? { meta: t('transfer.export.environmentsCount', { count: envCount }) } : {})}
                hint={t('transfer.export.environmentsShareHint')}
              />
              <ItemRow checked={inc.settings} onChange={(v) => set('settings', v)} label={t('transfer.export.settings')} hint={t('transfer.export.settingsHint')} />
              <ItemRow checked={inc.uiPrefs} onChange={(v) => set('uiPrefs', v)} label={t('transfer.export.uiPrefs')} hint={t('transfer.export.uiPrefsHint')} />
              <ItemRow checked={inc.runs} onChange={(v) => set('runs', v)} label={t('transfer.export.runs')} hint={t('transfer.export.runsHint')} />
            </>
          ) : (
            <>
              <ul className="tx-everything">
                <Included label={t('transfer.export.flows')} />
                <Included label={t('transfer.export.mocks')} />
                <Included label={t('transfer.export.environments')} hint={t('transfer.export.environmentsBackupHint')} />
                <Included label={t('transfer.export.settings')} />
                <Included label={t('transfer.export.uiPrefs')} />
                <Included label={t('transfer.export.slack')} hint={t('transfer.export.slackHint')} />
              </ul>
              <ItemRow checked={inc.runs} onChange={(v) => set('runs', v)} label={t('transfer.export.runs')} hint={t('transfer.export.runsHint')} />
            </>
          )}
        </section>

        {share ? null : (
          <section className="tx-section">
            <h3 className="tx-section__title">
              <KeyRound size={13} aria-hidden /> {t('transfer.export.secrets')}
            </h3>
            <p className="tx-hint">{t('transfer.export.passphraseHint')}</p>
            <div className="tx-pair">
              <Input size="sm" type="password" autoComplete="new-password" value={pass} placeholder={t('transfer.export.passphrase')} aria-label={t('transfer.export.passphrase')} onChange={(e) => setPass(e.target.value)} />
              <Input
                size="sm"
                type="password"
                autoComplete="new-password"
                value={pass2}
                disabled={!pass}
                placeholder={t('transfer.export.passphraseRepeat')}
                aria-label={t('transfer.export.passphraseRepeat')}
                aria-invalid={!!(passProblem && pass2) || undefined}
                onChange={(e) => setPass2(e.target.value)}
              />
            </div>
            {passProblem && pass2 ? (
              <div className="tx-error">{passProblem}</div>
            ) : pass && pass.length < MIN_PASSPHRASE ? (
              <p className="tx-hint">{t('transfer.export.passphraseShort', { min: MIN_PASSPHRASE })}</p>
            ) : pass ? (
              <p className={clsx('tx-hint', 'tx-hint--warn')}>{t('transfer.export.passphraseLost')}</p>
            ) : null}
            <Callout
              compact
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onClose();
                    ui.openSettings('backup');
                  }}
                >
                  {t('transfer.export.openSettings')}
                </Button>
              }
            >
              {t('transfer.export.autoHint')}
            </Callout>
          </section>
        )}
      </div>
    </Dialog>
  );
}

function ItemRow({ checked, onChange, label, hint, meta, disabled }: { checked: boolean; onChange(v: boolean): void; label: string; hint?: string; meta?: string; disabled?: boolean }) {
  return (
    <div className="tx-item">
      <Checkbox checked={checked} disabled={disabled} onChange={onChange} label={label} />
      {meta ? <span className="tx-item__meta">{meta}</span> : null}
      {hint ? <span className="tx-item__hint">{hint}</span> : null}
    </div>
  );
}

/** A part a backup always carries (only the run history is optional). */
function Included({ label, hint }: { label: string; hint?: string }) {
  return (
    <li className="tx-everything__item">
      <Check size={14} className="tx-everything__icon" aria-hidden />
      <span>{label}</span>
      {hint ? <span className="tx-everything__hint">{hint}</span> : null}
    </li>
  );
}
