import { useState, type Ref } from 'react';
import { Plug, Unplug } from 'lucide-react';
import type { AppSession, DeviceInfo } from '@durbun/protocol';
import { sendCommand, setScope } from '../../data';
import { Button, StatusDot, Textarea, formatClock, toast } from '../../components';
import { useT } from '../../i18n';
import { describeError } from './codes';
import { findVmUrl } from './model';
import { ActionErrorCallout, DeviceCard, type ActionError } from './useAction';

/** Dart VM Service: attach by pasting a VM service / DevTools URL or `flutter run` output; list and detach sessions. */
export function VmCard({ device, sessions, inputRef }: { device: DeviceInfo; sessions: readonly AppSession[]; inputRef?: Ref<HTMLTextAreaElement> }) {
  const t = useT();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [detaching, setDetaching] = useState<string | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const detected = input.trim() ? findVmUrl(input) : undefined;
  const vmSessions = sessions.filter((s) => s.transport === 'vm-service').sort((a, b) => Number(b.connected) - Number(a.connected) || b.connectedAt - a.connectedAt);

  const attach = async () => {
    const value = input.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await sendCommand({ name: 'vm.attach', input: value, deviceId: device.id });
      setInput('');
      toast.success(t('device.vm.attached'), res?.appId ? { action: { label: t('device.vm.show'), onClick: () => setScope({ kind: 'app', appId: res.appId }) } } : undefined);
    } catch (err) {
      const d = describeError(err);
      setError({ title: t('device.vm.attachFailed'), text: d.text, detail: d.detail });
      toast.error(t('device.vm.attachFailed'), { description: d.text });
    } finally {
      setBusy(false);
    }
  };

  const detach = async (s: AppSession) => {
    setDetaching(s.id);
    try {
      await sendCommand({ name: 'vm.detach', appId: s.id });
      toast.success(t('device.vm.detached'), { description: s.app.name });
    } catch (err) {
      toast.error(t('device.vm.detachFailed'), { description: describeError(err).text });
    } finally {
      setDetaching(null);
    }
  };

  return (
    <DeviceCard section="vm" title={t('device.vm.title')} icon={Plug} description={t('device.vm.description')}>
      <ActionErrorCallout error={error} onDismiss={() => setError(null)} />
      <form
        className="dv-vm"
        onSubmit={(e) => {
          e.preventDefault();
          void attach();
        }}
      >
        <Textarea
          ref={inputRef}
          mono
          rows={3}
          className="dv-vm__input"
          value={input}
          placeholder={t('device.vm.placeholder')}
          aria-label={t('device.vm.label')}
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void attach();
            }
          }}
        />
        <div className="dv-row">
          <span className="dv-hint truncate">{input.trim() ? (detected ? t('device.vm.detected', { url: detected }) : t('device.vm.noUrl')) : ''}</span>
          <span className="grow" />
          <Button type="submit" variant="primary" size="sm" icon={Plug} kbd="Mod+Enter" loading={busy} disabled={!input.trim()}>
            {t('device.vm.attach')}
          </Button>
        </div>
      </form>
      <div className="dv-subhead">
        <span>{t('device.vm.sessions')}</span>
      </div>
      {vmSessions.length === 0 ? (
        <p className="dv-muted">{t('device.vm.none')}</p>
      ) : (
        <ul className="dv-vm__list">
          {vmSessions.map((s) => (
            <li key={s.id} className="dv-vm__item">
              <StatusDot tone={s.connected ? 'success' : 'neutral'} size={7} />
              <span className="dv-vm__name truncate">{s.app.name || s.app.id}</span>
              <span className="subtle text-xs truncate">
                {s.connected ? t('device.vm.since', { time: formatClock(s.connectedAt, { ms: false }) }) : t('device.vm.ended')}
              </span>
              <span className="grow" />
              {s.connected ? (
                <Button size="sm" variant="ghost" icon={Unplug} loading={detaching === s.id} onClick={() => void detach(s)}>
                  {t('device.vm.detach')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </DeviceCard>
  );
}
