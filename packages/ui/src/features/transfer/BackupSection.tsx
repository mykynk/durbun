import './i18n';
import { useCallback, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Archive, FolderOpen, KeyRound, PackageOpen, RotateCcw, Share2 } from 'lucide-react';
import type { BackupSettings, BackupSettingsPatch } from '@durbun/protocol';
import { Button, Input, Select, Spinner, Toggle, confirm, formatBytes, formatDateTime, formatRelative, toast } from '../../components';
import { api, isConnected, ui, useConnection } from '../../data';
import type { BackupFile, BackupFolderSuggestion } from '../../data/api';
import { errorText, useLanguage, useT } from '../../i18n';
import { Group, OfflineNote, Row, SectionHeader } from '../../shell/settingsParts';
import { MIN_PASSPHRASE } from './ExportDialog';
import { readErrorText } from './ImportDialog';
import { transfer } from './store';

const INTERVALS = [6, 12, 24, 72, 168] as const;

/** Settings → Backup: automatic backups into a folder the user picks, and restoring one of them. */
export function BackupSection() {
  const t = useT();
  const lang = useLanguage();
  const connected = isConnected(useConnection((s) => s.status));
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [suggestions, setSuggestions] = useState<BackupFolderSuggestion[]>([]);
  const [files, setFiles] = useState<BackupFile[] | null>(null);
  const [folderDraft, setFolderDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [passOpen, setPassOpen] = useState(false);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');

  const loadFiles = useCallback((signal?: AbortSignal) => {
    api.backupFiles(signal).then(setFiles, () => setFiles([]));
  }, []);

  useEffect(() => {
    if (!connected) return;
    const ctrl = new AbortController();
    api.getBackup(ctrl.signal).then(
      (s) => {
        setSettings(s);
        setFolderDraft(s.folder ?? '');
      },
      (err: unknown) => {
        if ((err as { name?: string })?.name !== 'AbortError') toast.error(t('transfer.backup.loadFailed'), { description: errorText(err) });
      },
    );
    api.backupSuggestions(ctrl.signal).then(setSuggestions, () => setSuggestions([]));
    loadFiles(ctrl.signal);
    return () => ctrl.abort();
  }, [connected, loadFiles, t]);

  const update = async (key: string, patch: BackupSettingsPatch): Promise<boolean> => {
    setBusy(key);
    try {
      const next = await api.updateBackup(patch);
      setSettings(next);
      if ('folder' in patch) {
        setFolderDraft(next.folder ?? '');
        loadFiles();
      }
      return true;
    } catch (err) {
      toast.error(t('transfer.backup.saveFailed'), { description: errorText(err) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const runNow = async () => {
    setBusy('now');
    try {
      const r = await api.runBackup();
      setSettings(r.settings);
      toast.success(t('transfer.backup.nowDone', { file: r.file.split('/').pop() ?? r.file }), { description: formatBytes(r.size) });
      loadFiles();
    } catch (err) {
      toast.error(t('transfer.backup.nowFailed'), { description: errorText(err) });
      void api.getBackup().then(setSettings, () => undefined);
    } finally {
      setBusy(null);
    }
  };

  const restore = async (f: BackupFile) => {
    setBusy(`restore:${f.name}`);
    try {
      const text = await api.readBackupFile(f.name);
      ui.closeSettings();
      transfer.openImport(text, f.name);
    } catch (err) {
      toast.error(t('transfer.import.readFailed'), { description: readErrorText(err, t) });
    } finally {
      setBusy(null);
    }
  };

  const savePass = async () => {
    if (pass.length < MIN_PASSPHRASE || pass !== pass2) return;
    if (await update('pass', { passphrase: pass })) {
      setPassOpen(false);
      setPass('');
      setPass2('');
      toast.success(t('transfer.backup.passphraseSaved'));
    }
  };
  const forgetPass = async () => {
    const ok = await confirm({ title: t('transfer.backup.forgetTitle'), message: t('transfer.backup.forgetMessage'), confirmLabel: t('transfer.backup.forget'), danger: true });
    if (ok) await update('pass', { passphrase: null });
  };

  const passProblem = pass && pass.length < MIN_PASSPHRASE ? t('transfer.export.passphraseShort', { min: MIN_PASSPHRASE }) : pass && pass2 && pass !== pass2 ? t('transfer.export.passphraseMismatch') : null;
  const folderChanged = folderDraft.trim() !== (settings?.folder ?? '');
  const off = !connected || !settings;

  return (
    <>
      <SectionHeader title={t('transfer.backup.title')} description={t('transfer.backup.desc')} />
      <Group>
        <OfflineNote />
        {connected && !settings ? (
          <div className="tx-loading">
            <Spinner size={14} />
          </div>
        ) : null}
        <Row label={t('transfer.backup.folder')} hint={settings?.folder ? undefined : t('transfer.backup.folderHint')}>
          <form
            className="tx-folder"
            onSubmit={(e) => {
              e.preventDefault();
              if (folderChanged) void update('folder', { folder: folderDraft.trim() || null });
            }}
          >
            <Input
              size="sm"
              mono
              className="setting-text"
              value={folderDraft}
              disabled={off}
              placeholder={t('transfer.backup.folderPlaceholder')}
              aria-label={t('transfer.backup.folder')}
              spellCheck={false}
              onChange={(e) => setFolderDraft(e.target.value)}
            />
            {folderChanged ? (
              <Button size="sm" type="submit" loading={busy === 'folder'} disabled={off}>
                {t('common.save')}
              </Button>
            ) : null}
          </form>
        </Row>
        {suggestions.length ? (
          <div className="tx-suggest" role="group" aria-label={t('transfer.backup.suggestions')}>
            {suggestions.map((s) => {
              const current = settings?.folder === s.path;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={clsx('tx-suggest__item', current && 'is-current')}
                  disabled={off || current || busy !== null}
                  onClick={() => void update('folder', { folder: s.path })}
                  title={s.path}
                >
                  <FolderOpen size={14} aria-hidden />
                  <span className="tx-suggest__label">{s.label}</span>
                  <span className="tx-suggest__path">{s.path}</span>
                  <span className="tx-suggest__action">{current ? t('transfer.backup.inUse') : t('transfer.backup.use')}</span>
                </button>
              );
            })}
          </div>
        ) : null}
        <Row label={t('transfer.backup.auto')} hint={settings?.folder ? t('transfer.backup.autoHint') : t('transfer.backup.autoNeedsFolder')}>
          <Toggle checked={!!settings?.enabled} disabled={off || !settings?.folder || busy !== null} onChange={(v) => void update('enabled', { enabled: v })} aria-label={t('transfer.backup.auto')} />
        </Row>
        <Row label={t('transfer.backup.interval')}>
          <Select
            size="sm"
            value={String(settings?.intervalHours ?? 24)}
            disabled={off}
            aria-label={t('transfer.backup.interval')}
            options={INTERVALS.map((h) => ({ value: String(h), label: t(`transfer.backup.every.h${h}`) }))}
            onChange={(e) => void update('interval', { intervalHours: Number(e.target.value) })}
          />
        </Row>
        <Row label={t('transfer.backup.keep')} hint={t('transfer.backup.keepHint')}>
          <Select
            size="sm"
            value={String(settings?.keep ?? 10)}
            disabled={off}
            aria-label={t('transfer.backup.keep')}
            options={[3, 5, 10, 20, 50].map((n) => ({ value: String(n), label: String(n) }))}
            onChange={(e) => void update('keep', { keep: Number(e.target.value) })}
          />
        </Row>
        <Row label={t('transfer.backup.includeRuns')} hint={t('transfer.backup.includeRunsHint')}>
          <Toggle checked={!!settings?.includeRuns} disabled={off} onChange={(v) => void update('runs', { includeRuns: v })} aria-label={t('transfer.backup.includeRuns')} />
        </Row>
        <Row label={t('transfer.backup.secrets')} hint={settings?.hasPassphrase ? t('transfer.backup.secretsOn') : t('transfer.backup.secretsOff')}>
          <div className="tx-inline">
            <Button size="sm" variant="ghost" icon={KeyRound} disabled={off} onClick={() => setPassOpen((o) => !o)} aria-expanded={passOpen}>
              {settings?.hasPassphrase ? t('transfer.backup.changePassphrase') : t('transfer.backup.setPassphrase')}
            </Button>
            {settings?.hasPassphrase ? (
              <Button size="sm" variant="ghost" disabled={off || busy !== null} onClick={() => void forgetPass()}>
                {t('transfer.backup.forgetPassphrase')}
              </Button>
            ) : null}
          </div>
        </Row>
        {passOpen ? (
          <form
            className="tx-passform"
            onSubmit={(e) => {
              e.preventDefault();
              void savePass();
            }}
          >
            <p className="tx-hint">{t('transfer.backup.passphraseStoredHint')}</p>
            <div className="tx-pair">
              <Input size="sm" type="password" autoComplete="new-password" value={pass} placeholder={t('transfer.export.passphrase')} aria-label={t('transfer.export.passphrase')} onChange={(e) => setPass(e.target.value)} />
              <Input
                size="sm"
                type="password"
                autoComplete="new-password"
                value={pass2}
                placeholder={t('transfer.export.passphraseRepeat')}
                aria-label={t('transfer.export.passphraseRepeat')}
                aria-invalid={!!passProblem || undefined}
                onChange={(e) => setPass2(e.target.value)}
              />
              <div className="tx-inline tx-inline--tight">
                <Button size="sm" type="submit" loading={busy === 'pass'} disabled={!pass || !!passProblem || pass !== pass2}>
                  {t('common.save')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setPassOpen(false); setPass(''); setPass2(''); }}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
            {passProblem ? <div className="tx-error">{passProblem}</div> : null}
          </form>
        ) : null}
      </Group>

      <Group title={t('transfer.backup.last')}>
        <div className="tx-last">
          <div className="tx-last__text">
            {settings?.lastBackupAt ? (
              <>
                <span>{formatRelative(settings.lastBackupAt, Date.now(), { lang })}</span>
                <span className="tx-last__when">{formatDateTime(settings.lastBackupAt, { lang })}</span>
                {settings.lastBackupFile ? <code className="tx-last__file">{settings.lastBackupFile.split('/').pop()}</code> : null}
              </>
            ) : (
              <span className="tx-hint">{t('transfer.backup.lastNever')}</span>
            )}
            {settings?.lastError ? <div className="tx-error">{t('transfer.backup.lastError', { error: settings.lastError })}</div> : null}
            {settings?.lastWarning && !settings.lastError ? <div className="tx-hint tx-hint--warn">{t('transfer.backup.lastWarning', { error: settings.lastWarning })}</div> : null}
          </div>
          <Button size="sm" variant="primary" icon={Archive} loading={busy === 'now'} disabled={off || !settings?.folder || (busy !== null && busy !== 'now')} onClick={() => void runNow()}>
            {t('transfer.backup.now')}
          </Button>
        </div>
      </Group>

      {settings?.folder ? (
        <Group title={t('transfer.backup.files')}>
          {files === null ? (
            <div className="tx-loading">
              <Spinner size={14} />
            </div>
          ) : files.length === 0 ? (
            <p className="tx-hint">{t('transfer.backup.filesEmpty')}</p>
          ) : (
            <ul className="tx-files">
              {files.map((f) => (
                <li key={f.name} className="tx-files__row">
                  <Archive size={14} aria-hidden className="tx-files__icon" />
                  <span className="tx-files__name" title={f.file}>
                    {f.name}
                  </span>
                  <span className="tx-files__meta tnum">
                    {formatBytes(f.size, { lang })} · {formatDateTime(f.modifiedAt, { lang })}
                  </span>
                  <Button size="sm" variant="ghost" icon={RotateCcw} loading={busy === `restore:${f.name}`} disabled={off || busy !== null} onClick={() => void restore(f)}>
                    {t('transfer.backup.restore')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Group>
      ) : null}

      <Group>
        <div className="tx-inline">
          <Button
            size="sm"
            variant="ghost"
            icon={Archive}
            disabled={!connected}
            onClick={() => {
              ui.closeSettings();
              transfer.openExport('backup');
            }}
          >
            {t('transfer.backup.manual')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={Share2}
            disabled={!connected}
            onClick={() => {
              ui.closeSettings();
              transfer.openExport('share');
            }}
          >
            {t('transfer.menu.share')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={PackageOpen}
            disabled={!connected}
            onClick={() => {
              ui.closeSettings();
              transfer.openImport();
            }}
          >
            {t('transfer.backup.openPackage')}
          </Button>
        </div>
      </Group>
    </>
  );
}
