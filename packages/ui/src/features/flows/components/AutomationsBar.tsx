import { useMemo, useRef, useState } from 'react';
import { Pause, Play, Zap } from 'lucide-react';
import type { FlowSummary } from '@durbun/protocol';
import { Button, Popover, Spinner, Toggle, toast } from '../../../components';
import { errorText, useT } from '../../../i18n';
import { automatedFlows, pauseAutomations, resumable, resumeAutomations, setAutomation, usePausedAutomations, type BulkResult } from '../model/automations';

/**
 * Bottom of the flow list: how many flows start on their own, with the list to switch them off one by one and
 * "Pause all" for a quiet demo or a noisy device. A paused set can be brought back with one click.
 */
export function AutomationsBar({ summaries, onOpen }: { summaries: FlowSummary[]; onOpen(id: string): void }) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const paused = usePausedAutomations((s) => s.ids);
  const auto = useMemo(() => automatedFlows(summaries), [summaries]);
  const back = useMemo(() => resumable(paused, summaries), [paused, summaries]);
  const names = useMemo(() => new Map(summaries.map((f) => [f.id, f.name])), [summaries]);

  if (!auto.length && !back.length) return null;

  const failures = (res: BulkResult) => res.failed.map((f) => `${names.get(f.id) ?? f.id}: ${errorText(f.error)}`).join('\n');

  const resume = async (ids: string[]) => {
    setBusy('resume');
    try {
      const res = await resumeAutomations(ids);
      if (res.failed.length) toast.warn(t('flows.auto.resumePartial', { count: res.failed.length }), { description: failures(res) });
      else toast.success(t('flows.auto.resumed', { count: res.done.length }));
    } finally {
      setBusy(null);
    }
  };

  const pauseAll = async () => {
    setBusy('pause');
    try {
      const res = await pauseAutomations(auto.map((f) => f.id));
      if (res.failed.length) toast.warn(t('flows.auto.pausePartial', { count: res.failed.length }), { description: failures(res) });
      else if (res.done.length)
        toast.success(t('flows.auto.paused', { count: res.done.length }), {
          description: t('flows.auto.pausedHint'),
          action: { label: t('flows.auto.undo'), onClick: () => void resume(res.done) },
        });
      setOpen(false);
    } finally {
      setBusy(null);
    }
  };

  const switchOne = async (f: FlowSummary, on: boolean) => {
    setBusy(f.id);
    try {
      await setAutomation(f.id, on);
      if (!on) toast.success(t('flows.auto.switchedOff', { name: f.name }), { action: { label: t('flows.auto.undo'), onClick: () => void switchOne(f, true) } });
    } catch (err) {
      toast.error(t('flows.auto.switchFailed', { name: f.name }), { description: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  // Only paused flows left: the bar is the resume button itself.
  if (!auto.length) {
    return (
      <div className="fl-auto is-paused" role="status">
        <Pause size={14} aria-hidden className="fl-auto__icon" />
        <span className="fl-auto__text">{t('flows.auto.pausedCount', { count: back.length })}</span>
        <Button size="sm" variant="ghost" icon={Play} loading={busy === 'resume'} onClick={() => void resume(back.map((f) => f.id))}>
          {t('flows.auto.resume')}
        </Button>
      </div>
    );
  }

  return (
    <div className="fl-auto">
      <button ref={ref} type="button" className="fl-auto__open" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <Zap size={14} aria-hidden className="fl-auto__icon" />
        <span className="fl-auto__text">{t('flows.auto.count', { count: auto.length })}</span>
        {back.length ? <span className="fl-auto__more">{t('flows.auto.pausedCount', { count: back.length })}</span> : null}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} side="top" align="start" width={340} role="dialog" aria-label={t('flows.auto.title')}>
        <div className="fl-auto__pop">
          <div className="fl-auto__title">{t('flows.auto.title')}</div>
          <p className="fl-auto__hint">{t('flows.auto.hint')}</p>
          <ul className="fl-auto__list">
            {auto.map((f) => (
              <li key={f.id} className="fl-auto__row">
                <button
                  type="button"
                  className="fl-auto__name"
                  onClick={() => {
                    setOpen(false);
                    onOpen(f.id);
                  }}
                >
                  {f.name}
                </button>
                {busy === f.id ? <Spinner size={12} /> : null}
                <Toggle size="sm" checked aria-label={t('flows.auto.switch', { name: f.name })} disabled={!!busy} onChange={(v) => void switchOne(f, v)} />
              </li>
            ))}
          </ul>
          {back.length ? (
            <div className="fl-auto__paused">
              <span>{t('flows.auto.pausedCount', { count: back.length })}</span>
              <Button size="sm" variant="ghost" icon={Play} loading={busy === 'resume'} disabled={!!busy && busy !== 'resume'} onClick={() => void resume(back.map((f) => f.id))}>
                {t('flows.auto.resume')}
              </Button>
            </div>
          ) : null}
          <div className="fl-auto__actions">
            <Button size="sm" variant="secondary" icon={Pause} loading={busy === 'pause'} disabled={!!busy && busy !== 'pause'} onClick={() => void pauseAll()}>
              {t('flows.auto.pauseAll')}
            </Button>
          </div>
        </div>
      </Popover>
    </div>
  );
}
