import { useId, useMemo, useState } from 'react';
import { Bell, Braces, ChevronDown, CircleCheck, Send } from 'lucide-react';
import type { DeviceInfo } from '@durbun/protocol';
import { Button, DropdownMenu, Input, Textarea, formatNumber, usePersistentState } from '../../components';
import { useLanguage, useT } from '../../i18n';
import { APNS_TEMPLATES, templateText, validatePush, type AppRow, type PushTemplate } from './model';
import { ActionErrorCallout, DeviceCard, useDeviceAction } from './useAction';

export function PushCard({ device, apps, preferredAppId }: { device: DeviceInfo; apps: readonly AppRow[]; preferredAppId?: string }) {
  const t = useT();
  const id = useId();
  const userApps = apps.filter((a) => !a.system);
  const [appIdInput, setAppId] = useState<string | null>(null);
  const appId = appIdInput ?? (preferredAppId && userApps.some((a) => a.id === preferredAppId) ? preferredAppId : (userApps.find((a) => a.sdk)?.id ?? userApps[0]?.id ?? ''));
  const lang = useLanguage();
  // Null until the user edits or picks a template: the untouched default follows the UI language.
  const [stored, setPayload] = usePersistentState<string | null>('device.pushPayload.v2', null);
  const payload = typeof stored === 'string' ? stored : templateText('alert', lang);
  const { run, isPending, error, clearError } = useDeviceAction(device.id);
  const validation = useMemo(() => validatePush(payload), [payload]);

  const send = async () => {
    if (!validation.ok || !appId.trim()) return;
    await run({ action: 'push-notification', params: { appId: appId.trim(), payload: validation.payload }, success: t('device.push.done'), failure: t('device.push.failed') });
  };

  const status = validation.ok ? (
    <span className="dv-valid">
      <CircleCheck size={13} aria-hidden /> {t('device.push.valid', { bytes: formatNumber(validation.bytes) })}
    </span>
  ) : (
    <span className="dv-field-error" role="alert">
      {validation.error === 'json'
        ? t('device.push.error.json', { message: validation.message })
        : validation.error === 'tooLarge'
          ? t('device.push.error.tooLarge', { bytes: formatNumber(validation.bytes) })
          : t(`device.push.error.${validation.error}`)}
    </span>
  );

  return (
    <DeviceCard section="push" title={t('device.push.title')} icon={Bell}>
      <ActionErrorCallout error={error} onDismiss={clearError} />
      <div className="dv-row dv-row--field">
        <label className="dv-label" htmlFor={`${id}-app`}>
          {t('device.push.app')}
        </label>
        <Input
          id={`${id}-app`}
          size="sm"
          mono
          list={`${id}-apps`}
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
          placeholder={t('device.push.appPlaceholder')}
          className="grow"
          spellCheck={false}
          autoComplete="off"
        />
        <datalist id={`${id}-apps`}>
          {userApps.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </datalist>
      </div>
      <div className="dv-subhead">
        <label htmlFor={`${id}-payload`}>{t('device.push.payload')}</label>
        <span className="grow" />
        <DropdownMenu
          items={(Object.keys(APNS_TEMPLATES) as PushTemplate[]).map((k) => ({ label: t(`device.push.templates.${k}`), onSelect: () => setPayload(templateText(k, lang)) }))}
          align="end"
        >
          {(p) => (
            <Button {...p} size="sm" variant="ghost" iconRight={ChevronDown}>
              {t('device.push.template')}
            </Button>
          )}
        </DropdownMenu>
        <Button
          size="sm"
          variant="ghost"
          icon={Braces}
          disabled={!validation.ok}
          onClick={() => {
            if (validation.ok) setPayload(JSON.stringify(validation.payload, null, 2));
          }}
        >
          {t('device.push.format')}
        </Button>
      </div>
      <Textarea
        id={`${id}-payload`}
        mono
        rows={9}
        className="dv-json"
        value={payload}
        invalid={!validation.ok}
        spellCheck={false}
        onChange={(e) => setPayload(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="dv-row">
        {status}
        <span className="grow" />
        {!appId.trim() ? <span className="dv-hint">{t('device.push.needApp')}</span> : null}
        <Button variant="primary" size="sm" icon={Send} kbd="Mod+Enter" loading={isPending('push-notification')} disabled={!validation.ok || !appId.trim()} onClick={() => void send()}>
          {t('device.push.send')}
        </Button>
      </div>
    </DeviceCard>
  );
}
