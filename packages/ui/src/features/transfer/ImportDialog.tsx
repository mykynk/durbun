import './i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { CircleCheck, FileUp, KeyRound, PackageOpen, TriangleAlert, Workflow } from 'lucide-react';
import type { PackageConflict, PackageImportRequest, PackageImportResult, PackageItemPreview, PackageManifest } from '@durbun/protocol';
import { Button, Callout, Checkbox, Dialog, EmptyState, Input, SegmentedControl, Spinner, formatDateTime, pickFiles, toast } from '../../components';
import { ApiError, api, ui } from '../../data';
import { errorText, t as tNow, tCode, useT, type TFunction } from '../../i18n';
import { loadEnvironments } from '../flows/model/envStore';
import { applyUiPrefs } from './prefsSync';

type Parts = Required<Omit<PackageImportRequest['include'], 'flows'>>;

const NO_PARTS: Parts = { mocks: false, environments: false, settings: false, uiPrefs: false, slack: false, runs: false };

/** The server reads packages of up to this size (PACKAGE_JSON_LIMIT_BYTES). */
export const PACKAGE_LIMIT_MB = 256;

/** Some editors start a file with a byte order mark; JSON does not allow one. */
export const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Why a package could not be read, in the user's words: a damaged or too large file says so plainly. */
export function readErrorText(err: unknown, t: TFunction): string {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  if (code === 'body.invalidJson' || code === 'package.damaged') return t('transfer.import.damaged');
  if (code === 'body.tooLarge' || code === 'package.tooLarge') return t('transfer.import.tooLarge', { limit: PACKAGE_LIMIT_MB });
  return errorText(err);
}

/** Opens a `.durbun` package: shows what it holds, the user picks what comes in, then imports. */
export function ImportDialog({ open, text: initialText, fileName: initialName, onClose }: { open: boolean; text: string | null; fileName?: string; onClose(): void }) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | undefined>();
  const [manifest, setManifest] = useState<PackageManifest | null>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [flows, setFlows] = useState<Set<string>>(new Set());
  const [parts, setParts] = useState<Parts>(NO_PARTS);
  const [conflict, setConflict] = useState<PackageConflict>('keepBoth');
  const [pass, setPass] = useState('');
  const [passState, setPassState] = useState<'ok' | 'checking' | null>(null);
  const [passError, setPassError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  /** After an import that left something to do: what came in and what needs a look. */
  const [result, setResult] = useState<PackageImportResult | null>(null);
  /** The server keeps the package read for this dialog under this token until the dialog lets it go. */
  const token = useRef<string | undefined>(undefined);

  const releaseToken = () => {
    const held = token.current;
    token.current = undefined;
    if (held) void api.releasePackage(held).catch(() => undefined);
  };

  useEffect(() => {
    if (!open) return;
    setText(initialText === null ? null : stripBom(initialText));
    setFileName(initialName);
    setPass('');
    setPassState(null);
    setPassError(null);
  }, [open, initialText, initialName]);

  // Read what the package holds (nothing is saved yet).
  useEffect(() => {
    setManifest(null);
    setReadError(null);
    setResult(null);
    if (!open || !text) return;
    if (text.length > PACKAGE_LIMIT_MB * 1024 * 1024) {
      setReadError({ code: 'package.tooLarge', message: 'The file is too large' });
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    api
      .inspectPackage(text, undefined, ctrl.signal)
      .then(
        (m) => {
          token.current = m.token;
          setManifest(m);
          const backup = m.kind === 'backup';
          setFlows(new Set(m.flows.filter((f) => !(f.exists && !f.differs)).map((f) => f.id)));
          setParts({
            mocks: m.mocks.length > 0,
            environments: m.environments.length > 0,
            // Someone else's server settings, theme and language are not forced on a teammate; a backup is this person's own.
            settings: m.settings && backup,
            uiPrefs: m.uiPrefs && backup,
            slack: m.slack,
            runs: m.runs > 0,
          });
          setConflict(backup ? 'replace' : 'keepBoth');
        },
        (err: unknown) => {
          if ((err as { name?: string })?.name !== 'AbortError') setReadError(err);
        },
      )
      .finally(() => setLoading(false));
    return () => {
      ctrl.abort();
      releaseToken();
    };
  }, [open, text]);

  const choose = async () => {
    const [file] = await pickFiles({ accept: '.durbun,.json,application/json' });
    if (!file) return;
    try {
      setText(stripBom(await file.text()));
      setFileName(file.name);
      setPass('');
      setPassState(null);
      setPassError(null);
    } catch (err) {
      toast.error(t('transfer.import.readFailed'), { description: errorText(err) });
    }
  };

  /** True when the typed passphrase opens the secrets; a wrong one shows under the field. */
  const checkPass = async (): Promise<boolean> => {
    if (!text || !pass || !manifest) return false;
    setPassState('checking');
    setPassError(null);
    try {
      let m: PackageManifest;
      try {
        // The server still holds the package: only the passphrase travels.
        m = manifest.token ? await api.inspectStagedPackage(manifest.token, pass) : await api.inspectPackage(text, pass);
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'package.expired')) throw err;
        m = await api.inspectPackage(text, pass);
        token.current = m.token;
      }
      if (m.passphraseOk) {
        setManifest((cur) => (cur ? { ...cur, token: m.token, passphraseOk: true } : m));
        setPassState('ok');
        return true;
      }
      setPassState(null);
      setPassError({ code: 'package.passphrase.wrong', message: 'The passphrase is wrong, or the file was changed after it was saved' });
    } catch (err) {
      setPassState(null);
      setPassError(err);
    }
    return false;
  };

  const conflicts = useMemo(() => {
    if (!manifest) return 0;
    const differs = (list: PackageItemPreview[]) => list.filter((i) => i.exists && i.differs).length;
    return differs(manifest.flows.filter((f) => flows.has(f.id))) + (parts.mocks ? differs(manifest.mocks) : 0) + (parts.environments ? differs(manifest.environments) : 0);
  }, [manifest, flows, parts]);

  const picked = !!manifest && (flows.size > 0 || Object.values(parts).some(Boolean));
  const automated = manifest && manifest.kind !== 'backup' ? manifest.flows.filter((f) => f.automation && flows.has(f.id)).length : 0;

  const run = async () => {
    if (!manifest || !text || !picked) return;
    // A passphrase typed but not checked yet: check it now rather than leave the secrets behind unnoticed.
    if (pass && passState !== 'ok' && !(await checkPass())) return;
    setBusy(true);
    const include: PackageImportRequest['include'] = {
      flows: flows.size === manifest.flows.length ? 'all' : [...flows],
      ...parts,
    };
    const passphrase = pass || undefined;
    try {
      let r: PackageImportResult;
      try {
        r = await api.importPackage({ token: manifest.token, include, conflict, ...(passphrase ? { passphrase } : {}) });
      } catch (err) {
        // The server keeps a read package for a while only: send it again.
        if (!(err instanceof ApiError && err.code === 'package.expired')) throw err;
        r = await api.importPackage({ package: JSON.parse(text), include, conflict, ...(passphrase ? { passphrase } : {}) });
      }
      // The import used the kept package up.
      token.current = undefined;
      if (r.uiPrefs) applyUiPrefs(r.uiPrefs);
      // Views that already read the environments (Flows) see the imported ones, and never save over them.
      void loadEnvironments();
      if (hasFollowUps(r)) {
        setResult(r);
        return;
      }
      // The restored preferences may switch the language: speak the new one.
      const summary = resultSummary(r, tNow);
      if (summary) toast.success(tNow('transfer.import.done'), { description: summary });
      else toast.info(tNow('transfer.import.nothingNew'));
      onClose();
    } catch (err) {
      toast.error(t('transfer.import.failed'), { description: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const setPart = (k: keyof Parts, v: boolean) => setParts((s) => ({ ...s, [k]: v }));
  const by = manifest?.createdBy;
  const source = by?.host ?? [by?.app ?? 'Dürbün', by?.version ?? ''].join(' ').trim();
  const flowsFollowUp = !!result && ((result.emptySecrets?.length ?? 0) > 0 || (result.automationOff ?? 0) > 0);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon={PackageOpen}
      title={manifest?.name ?? (manifest?.kind === 'backup' && by?.host ? t('transfer.import.backupOf', { host: by.host }) : t('transfer.import.title'))}
      description={manifest ? undefined : t('transfer.import.description')}
      size="md"
      footer={
        result ? (
          <>
            <span className="grow" />
            {flowsFollowUp ? (
              <Button
                variant="ghost"
                icon={Workflow}
                onClick={() => {
                  onClose();
                  ui.setTab('flows');
                }}
              >
                {t('transfer.import.goToFlows')}
              </Button>
            ) : null}
            <Button variant="primary" onClick={onClose}>
              {t('common.done')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" icon={FileUp} onClick={() => void choose()}>
              {t('transfer.import.pick')}
            </Button>
            <span className="grow" />
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" icon={PackageOpen} loading={busy} disabled={!picked || loading} onClick={() => void run()}>
              {t('transfer.import.button')}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <ImportResult result={result} />
      ) : !text ? (
        <EmptyState size="sm" icon={FileUp} title={t('transfer.import.empty')} actions={<Button onClick={() => void choose()}>{t('transfer.import.pick')}</Button>} />
      ) : loading ? (
        <div className="tx-loading">
          <Spinner size={16} />
          {t('transfer.import.reading')}
        </div>
      ) : readError ? (
        <EmptyState size="sm" tone="danger" icon={TriangleAlert} title={t('transfer.import.readFailed')} description={readErrorText(readError, t)} />
      ) : manifest ? (
        <div className="tx-import">
          <div className="tx-meta">
            <span className={clsx('tx-kind', `is-${manifest.kind}`)}>{t(`transfer.import.kind.${manifest.kind}`)}</span>
            <span className="tx-meta__from">{manifest.createdAt > 0 ? t('transfer.import.from', { source, when: formatDateTime(manifest.createdAt) }) : source}</span>
            {fileName ? <code className="tx-meta__file">{fileName}</code> : null}
          </div>
          {manifest.note ? <p className="tx-note">{manifest.note}</p> : null}

          <section className="tx-section">
            <h3 className="tx-section__title">{t('transfer.import.choose')}</h3>
            {manifest.flows.length ? (
              <>
                <div className="tx-item">
                  <Checkbox
                    checked={flows.size === manifest.flows.length}
                    indeterminate={flows.size > 0 && flows.size < manifest.flows.length}
                    onChange={(c) => setFlows(new Set(c ? manifest.flows.map((f) => f.id) : []))}
                    label={t('transfer.import.flows')}
                  />
                  <span className="tx-item__meta">{t('transfer.import.flowsCount', { count: manifest.flows.length })}</span>
                </div>
                <div className="tx-flowlist" role="group" aria-label={t('transfer.import.flows')}>
                  {manifest.flows.map((f) => (
                    <div key={f.id} className="tx-flowlist__row">
                      <Checkbox
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
                      <StateChip item={f} conflict={conflict} />
                    </div>
                  ))}
                </div>
                {automated ? <p className="tx-hint">{t('transfer.import.automationHint', { count: automated })}</p> : null}
              </>
            ) : null}
            {manifest.mocks.length ? (
              <PartRow checked={parts.mocks} onChange={(v) => setPart('mocks', v)} label={t('transfer.import.mocks')} meta={t('transfer.import.mocksCount', { count: manifest.mocks.length })} items={manifest.mocks} />
            ) : null}
            {manifest.environments.length ? (
              <PartRow
                checked={parts.environments}
                onChange={(v) => setPart('environments', v)}
                label={t('transfer.import.environments')}
                meta={`${t('transfer.import.envCount', { count: manifest.environments.length })} · ${t('transfer.import.varCount', { count: manifest.envVarCount })}`}
                items={manifest.environments}
              />
            ) : null}
            {manifest.settings ? <PartRow checked={parts.settings} onChange={(v) => setPart('settings', v)} label={t('transfer.import.settings')} hint={t('transfer.import.settingsHint')} /> : null}
            {manifest.uiPrefs ? <PartRow checked={parts.uiPrefs} onChange={(v) => setPart('uiPrefs', v)} label={t('transfer.import.uiPrefs')} hint={t('transfer.import.uiPrefsHint')} /> : null}
            {manifest.slack ? <PartRow checked={parts.slack} onChange={(v) => setPart('slack', v)} label={t('transfer.import.slack')} hint={manifest.hasSecrets ? t('transfer.import.slackHint') : undefined} /> : null}
            {manifest.runs ? <PartRow checked={parts.runs} onChange={(v) => setPart('runs', v)} label={t('transfer.import.runs')} meta={t('transfer.import.runsCount', { count: manifest.runs })} /> : null}
          </section>

          {conflicts > 0 ? (
            <div className="tx-conflict">
              <span>{t('transfer.import.conflictLabel')}</span>
              <SegmentedControl
                size="sm"
                value={conflict}
                onChange={setConflict}
                aria-label={t('transfer.import.conflictLabel')}
                options={[
                  { value: 'keepBoth', label: t('transfer.import.conflict.keepBoth') },
                  { value: 'replace', label: t('transfer.import.conflict.replace') },
                  { value: 'skip', label: t('transfer.import.conflict.skip') },
                ]}
              />
            </div>
          ) : null}

          {manifest.hasSecrets ? (
            <section className="tx-section">
              <h3 className="tx-section__title">
                <KeyRound size={13} aria-hidden /> {t('transfer.import.secrets')}
              </h3>
              <p className="tx-hint">{t('transfer.import.secretsHint')}</p>
              <form
                className="tx-pass"
                onSubmit={(e) => {
                  e.preventDefault();
                  void checkPass();
                }}
              >
                <Input
                  size="sm"
                  type="password"
                  autoComplete="off"
                  value={pass}
                  placeholder={t('transfer.import.passphrase')}
                  aria-label={t('transfer.import.passphrase')}
                  aria-invalid={!!passError || undefined}
                  onChange={(e) => {
                    setPass(e.target.value);
                    setPassState(null);
                    setPassError(null);
                  }}
                />
                {passState === 'ok' ? (
                  <span className="tx-ok" role="status">
                    <CircleCheck size={14} aria-hidden />
                    {t('transfer.import.passOk')}
                  </span>
                ) : (
                  <Button size="sm" type="submit" loading={passState === 'checking'} disabled={!pass}>
                    {t('transfer.import.check')}
                  </Button>
                )}
              </form>
              {passError ? <div className="tx-error">{errorText(passError)}</div> : null}
            </section>
          ) : null}

          {manifest.warnings.length ? (
            <section className="tx-section">
              <h3 className="tx-section__title">{t('transfer.import.warnings')}</h3>
              <ul className="tx-warnings">
                {manifest.warnings.map((w, i) => (
                  <li key={i}>
                    <TriangleAlert size={12} aria-hidden />
                    {tCode(w.code, w.params, w.message)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

/** Something the user should do or know after the import (shown in the dialog instead of a passing toast). */
export function hasFollowUps(r: PackageImportResult): boolean {
  return (r.emptySecrets?.length ?? 0) > 0 || (r.automationOff ?? 0) > 0 || (r.notices?.length ?? r.warnings.length) > 0;
}

/** What came in, what was already here, and what needs a look: empty secrets, automation switched off, warnings. */
function ImportResult({ result: r }: { result: PackageImportResult }) {
  const t = useT();
  const summary = resultSummary(r, t);
  const same = (r.flows.same ?? 0) + (r.mocks.same ?? 0) + (r.environments.same ?? 0);
  const envEmpty = (r.emptySecrets ?? []).filter((e) => e.kind === 'env');
  const inputEmpty = (r.emptySecrets ?? []).filter((e) => e.kind === 'input');
  const count = (list: typeof envEmpty) => list.reduce((n, e) => n + e.keys.length, 0);
  const notices = r.notices ?? r.warnings.map((message) => ({ code: '', message, params: undefined }));
  return (
    <div className="tx-import">
      <div className="tx-result">
        <CircleCheck size={18} className="tx-result__icon" aria-hidden />
        <div className="tx-result__text">
          <div className="tx-result__title">{summary ? t('transfer.import.done') : t('transfer.import.nothingNew')}</div>
          {summary ? <div className="tx-result__summary">{summary}</div> : null}
          {same ? <div className="tx-hint">{t('transfer.import.same', { count: same })}</div> : null}
        </div>
      </div>
      <Callout tone="warn" title={t('transfer.import.followUp')}>
        <ul className="tx-followups">
          {envEmpty.length ? (
            <li>
              {t('transfer.import.emptySecrets', { count: count(envEmpty) })}
              <span className="tx-followups__keys">{envEmpty.map((e) => `${e.name}: ${e.keys.join(', ')}`).join(' · ')}</span>
            </li>
          ) : null}
          {inputEmpty.length ? (
            <li>
              {t('transfer.import.emptyInputs', { count: count(inputEmpty) })}
              <span className="tx-followups__keys">{inputEmpty.map((e) => `${e.name}: ${e.keys.join(', ')}`).join(' · ')}</span>
            </li>
          ) : null}
          {r.automationOff ? <li>{t('transfer.import.automationOff', { count: r.automationOff })}</li> : null}
          {notices.map((n, i) => (
            <li key={i}>{n.code ? tCode(n.code, n.params, n.message) : n.message}</li>
          ))}
        </ul>
      </Callout>
    </div>
  );
}

/** What happens to this flow with the chosen conflict mode, so the chip never contradicts the choice. */
function StateChip({ item, conflict }: { item: PackageItemPreview; conflict: PackageConflict }) {
  const t = useT();
  const state = !item.exists ? 'new' : !item.differs ? 'same' : conflict === 'keepBoth' ? 'copy' : conflict === 'skip' ? 'skipped' : 'changed';
  return <span className={clsx('tx-chip', `is-${state}`)}>{t(`transfer.import.state.${state}`)}</span>;
}

function PartRow({ checked, onChange, label, meta, hint, items }: { checked: boolean; onChange(v: boolean): void; label: string; meta?: string; hint?: string; items?: PackageItemPreview[] }) {
  const t = useT();
  const existing = items?.filter((i) => i.exists).length ?? 0;
  return (
    <div className="tx-item">
      <Checkbox checked={checked} onChange={onChange} label={label} />
      {meta ? <span className="tx-item__meta">{meta}</span> : null}
      {existing ? <span className="tx-item__meta">· {t('transfer.import.existing', { count: existing })}</span> : null}
      {hint ? <span className="tx-item__hint">{hint}</span> : null}
    </div>
  );
}

/** "3 flows, 2 mock rules, settings" — empty when nothing came in. */
export function resultSummary(r: PackageImportResult, t: TFunction): string {
  const parts: string[] = [];
  const flows = r.flows.added + r.flows.replaced + r.flows.renamed;
  const mocks = r.mocks.added + r.mocks.replaced;
  const envs = r.environments.added + r.environments.replaced;
  if (flows) parts.push(t('transfer.import.part.flows', { count: flows }));
  if (mocks) parts.push(t('transfer.import.part.mocks', { count: mocks }));
  if (envs) parts.push(t('transfer.import.part.environments', { count: envs }));
  if (r.settings) parts.push(t('transfer.import.part.settings'));
  if (r.uiPrefs) parts.push(t('transfer.import.part.uiPrefs'));
  if (r.slack) parts.push(t('transfer.import.part.slack'));
  if (r.runs) parts.push(t('transfer.import.part.runs', { count: r.runs }));
  if (r.secretsRestored) parts.push(t('transfer.import.part.secrets'));
  return parts.join(', ');
}
