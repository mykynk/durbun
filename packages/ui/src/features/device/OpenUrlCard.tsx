import { useState, type Ref } from 'react';
import { ExternalLink, Link as LinkIcon, X } from 'lucide-react';
import type { DeviceInfo } from '@durbun/protocol';
import { Button, IconButton, Input, Select, toast, usePersistentState } from '../../components';
import { useT } from '../../i18n';
import { openUrlParams, pushHistory, urlProblem, type AppRow } from './model';
import { ActionErrorCallout, DeviceCard, useDeviceAction } from './useAction';

export function OpenUrlCard({ device, apps, inputRef }: { device: DeviceInfo; apps: readonly AppRow[]; inputRef?: Ref<HTMLInputElement> }) {
  const t = useT();
  const [url, setUrl] = useState('');
  const [storedHistory, setHistory] = usePersistentState<string[]>('device.urlHistory', []);
  const history = Array.isArray(storedHistory) ? storedHistory.filter((x) => typeof x === 'string') : [];
  const [appId, setAppId] = useState('');
  const { run, isPending, error, clearError } = useDeviceAction(device.id);
  const problem = url.trim() ? urlProblem(url) : null;
  const busy = isPending('open-url');

  const open = async (value: string) => {
    const v = value.trim();
    if (urlProblem(v)) return;
    const r = await run({ action: 'open-url', params: openUrlParams(v, appId || undefined), failure: t('device.url.failed') });
    if (!r.ok) return;
    toast.success(t('device.url.done'), { description: v });
    setHistory((h) => pushHistory(Array.isArray(h) ? h : [], v));
  };

  const userApps = apps.filter((a) => !a.system);

  return (
    <DeviceCard section="open-url" title={t('device.url.title')} icon={LinkIcon}>
      <ActionErrorCallout error={error} onDismiss={clearError} />
      <form
        className="dv-row"
        onSubmit={(e) => {
          e.preventDefault();
          void open(url);
        }}
      >
        <Input
          ref={inputRef}
          size="md"
          mono
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('device.url.placeholder')}
          aria-label={t('device.url.label')}
          invalid={Boolean(problem)}
          spellCheck={false}
          autoComplete="off"
          wrapperClassName="grow"
          className="grow"
        />
        <Button type="submit" variant="primary" icon={ExternalLink} loading={busy} disabled={!url.trim() || Boolean(problem)}>
          {t('device.url.open')}
        </Button>
      </form>
      {problem ? <p className="dv-field-error">{t(`device.url.problem.${problem}`)}</p> : null}
      {userApps.length > 0 ? (
        <div className="dv-row dv-row--field">
          <label className="dv-label" htmlFor={`dv-url-app-${device.id}`}>
            {t('device.url.app')}
          </label>
          <Select
            id={`dv-url-app-${device.id}`}
            size="sm"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            options={[{ value: '', label: t('device.url.appAuto') }, ...userApps.map((a) => ({ value: a.id, label: `${a.name} · ${a.id}` }))]}
            className="grow"
          />
        </div>
      ) : null}
      {userApps.length > 0 ? <p className="dv-hint">{t('device.url.appHint')}</p> : null}
      <div className="dv-subhead">
        <span>{t('device.url.history')}</span>
        {history.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => setHistory([])}>
            {t('device.url.clearHistory')}
          </Button>
        ) : null}
      </div>
      {history.length === 0 ? (
        <p className="dv-muted">{t('device.url.historyEmpty')}</p>
      ) : (
        <ul className="dv-history">
          {history.map((h) => (
            <li key={h} className="dv-history__item">
              <button
                type="button"
                className="dv-history__url mono"
                title={t('device.url.reopen', { url: h })}
                aria-label={t('device.url.reopen', { url: h })}
                disabled={busy}
                onClick={() => {
                  setUrl(h);
                  void open(h);
                }}
              >
                <ExternalLink size={12} aria-hidden className="dv-history__icon" />
                <span className="truncate">{h}</span>
              </button>
              <IconButton icon={X} size="xs" label={t('device.url.removeItem')} onClick={() => setHistory((list) => (Array.isArray(list) ? list.filter((x) => x !== h) : []))} />
            </li>
          ))}
        </ul>
      )}
    </DeviceCard>
  );
}
