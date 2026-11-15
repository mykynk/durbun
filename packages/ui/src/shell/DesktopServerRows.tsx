import { useEffect, useState } from 'react';
import { RotateCcw, RotateCw } from 'lucide-react';
import { useT } from '../i18n';
import { Button } from '../components/Button';
import { Toggle } from '../components/Controls';
import { Input } from '../components/Form';
import { Callout } from '../components/Layout';
import { confirm } from '../components/Dialog';
import { toast } from '../components/Toast';
import { Row } from './settingsParts';
import { MAX_PORT, MIN_USER_PORT, canRelaunch, isUserPort, relaunchDesktop, useDesktopConfig, type ConfigField, type ConfigKey, type ConfigPatch, type ConfigResult } from './desktopConfig';

/**
 * Settings → Mac app: the ports and verbose log of the server inside Dürbün.app, and a restart when a change
 * waits for one. Rendered only with the app's bridge (`durbunDesktop.config`).
 */
export function DesktopServerRows() {
  const t = useT();
  const { available, config, saving, set } = useDesktopConfig();
  const [errors, setErrors] = useState<Partial<Record<ConfigKey, string>>>({});
  if (!available) return null;

  const apply = async (key: ConfigKey, patch: ConfigPatch): Promise<boolean> => {
    const r: ConfigResult = await set(patch);
    if (r.ok) {
      setErrors((e) => ({ ...e, [key]: undefined }));
      return true;
    }
    if (r.error === 'bridge') {
      toast.error(t('shell.settings.desktop.failed'));
      return false;
    }
    setErrors((e) => ({ ...e, [r.field]: t(`shell.settings.desktop.errors.${r.error}`, { min: MIN_USER_PORT, max: MAX_PORT }) }));
    return false;
  };

  const restart = async () => {
    const ok = await confirm({
      title: t('shell.settings.desktop.restartTitle'),
      message: t('shell.settings.desktop.restartMessage'),
      confirmLabel: t('shell.settings.desktop.restart'),
    });
    if (!ok) return;
    if (!(await relaunchDesktop())) toast.error(t('shell.settings.desktop.restartFailed'));
  };

  return (
    <>
      <PortRow
        label={t('shell.settings.desktop.httpPort')}
        hint={t('shell.settings.desktop.httpPortHint')}
        field={config?.httpPort}
        listening={config?.listening.httpPort ?? null}
        disabled={!config || saving}
        error={errors.httpPort}
        onSave={(v) => apply('httpPort', { httpPort: v })}
        onClearError={() => setErrors((e) => ({ ...e, httpPort: undefined }))}
      />
      <PortRow
        label={t('shell.settings.desktop.sdkPort')}
        hint={t('shell.settings.desktop.sdkPortHint')}
        field={config?.sdkPort}
        listening={config?.listening.sdkPort ?? null}
        disabled={!config || saving}
        error={errors.sdkPort}
        extra={config && config.sdkPort.value !== config.sdkPort.default ? t('shell.settings.desktop.sdkPortSdks', { port: config.sdkPort.value }) : undefined}
        onSave={(v) => apply('sdkPort', { sdkPort: v })}
        onClearError={() => setErrors((e) => ({ ...e, sdkPort: undefined }))}
      />
      <Row
        label={t('shell.settings.desktop.verboseLog')}
        hint={
          config?.verboseLog.source === 'env'
            ? t('shell.settings.desktop.fromEnv', { name: config.verboseLog.env })
            : (errors.verboseLog ?? (config?.verboseLog.pending ? t('shell.settings.desktop.afterRestart') : t('shell.settings.desktop.verboseLogHint')))
        }
      >
        <Toggle
          checked={config?.verboseLog.value === true}
          disabled={!config || saving || config.verboseLog.source === 'env'}
          onChange={(v) => void apply('verboseLog', { verboseLog: v === config?.verboseLog.default ? null : v })}
          aria-label={t('shell.settings.desktop.verboseLog')}
        />
      </Row>
      {config?.restartNeeded ? (
        <Callout tone="info" compact className="settings__desktop-restart">
          <span>{t('shell.settings.desktop.restartNeeded')}</span>
          {canRelaunch() ? (
            <Button size="sm" variant="secondary" icon={RotateCw} onClick={() => void restart()}>
              {t('shell.settings.desktop.restart')}
            </Button>
          ) : null}
        </Callout>
      ) : null}
    </>
  );
}

function PortRow({
  label,
  hint,
  field,
  listening,
  disabled,
  error,
  extra,
  onSave,
  onClearError,
}: {
  label: string;
  hint: string;
  field: ConfigField<number> | undefined;
  listening: number | null;
  disabled: boolean;
  error?: string;
  /** Said after the note (the SDK port: the apps' SDKs must use the same port). */
  extra?: string;
  onSave(v: number | null): Promise<boolean>;
  onClearError(): void;
}) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const value = field?.value;
  useEffect(() => {
    if (value !== undefined) setDraft(String(value));
  }, [value]);
  const fromEnv = field?.source === 'env';
  const n = Number(draft.trim());
  const changed = !!field && draft.trim() !== '' && n !== field.value;
  const bad = draft.trim() !== '' && !isUserPort(n);

  const save = async () => {
    if (!field || !changed || bad) return;
    await onSave(n === field.default ? null : n);
  };

  let note: string;
  if (error) note = error;
  else if (bad) note = t('shell.settings.desktop.errors.invalidPort', { min: MIN_USER_PORT, max: MAX_PORT });
  else if (fromEnv) note = t('shell.settings.desktop.fromEnv', { name: field!.env });
  else if (field?.pending) note = listening !== null ? t('shell.settings.desktop.pendingPort', { port: listening }) : t('shell.settings.desktop.afterRestart');
  else note = hint;
  if (extra && !error && !bad) note = `${note} ${extra}`;

  return (
    <Row label={label} hint={<span className={error || bad ? 'settings__desktop-error' : undefined}>{note}</span>}>
      <div className="settings__desktop-port">
        <Input
          size="sm"
          mono
          inputMode="numeric"
          className="settings__desktop-portinput tnum"
          value={draft}
          disabled={disabled || fromEnv}
          invalid={bad || !!error}
          aria-label={label}
          onChange={(e) => {
            setDraft(e.target.value.replace(/[^\d]/g, '').slice(0, 5));
            onClearError();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape' && value !== undefined) setDraft(String(value));
          }}
        />
        {changed ? (
          <Button size="sm" disabled={disabled || bad} onClick={() => void save()}>
            {t('shell.settings.desktop.save')}
          </Button>
        ) : field && !fromEnv && field.source === 'file' && field.value !== field.default ? (
          <Button size="sm" variant="ghost" icon={RotateCcw} disabled={disabled} onClick={() => void onSave(null)} title={t('shell.settings.desktop.defaultHint', { port: field.default })}>
            {t('shell.settings.desktop.default')}
          </Button>
        ) : null}
      </div>
    </Row>
  );
}
