import { useEffect, useMemo, useState } from 'react';
import { Circle, Download, ExternalLink, Video } from 'lucide-react';
import type { DeviceInfo } from '@durbun/protocol';
import { Button, SegmentedControl, downloadUrl, formatClock, toast, usePersistentState } from '../../components';
import { useT } from '../../i18n';
import { codeText } from './codes';
import { mediaFileName, mediaResult, recordDurations } from './model';
import { addRecording, useMedia } from './stores';
import { ActionErrorCallout, DeviceCard, useDeviceAction } from './useAction';

function useClock(enabled: boolean, ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [enabled, ms]);
  return now;
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Screen recording: the protocol records for a fixed `durationSec` (no stop command), so the card shows a
 * countdown and then waits for the file to be copied from the device.
 */
export function RecordCard({ device }: { device: DeviceInfo }) {
  const t = useT();
  const durations = recordDurations(device);
  const [stored, setDuration] = usePersistentState<number>('device.recordSec', 30);
  const duration = durations.includes(stored) ? stored : 30;
  const { run, isPending, error, clearError } = useDeviceAction(device.id);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const recording = isPending('screen-record');
  const now = useClock(recording);
  const all = useMedia((s) => s.recordings);
  const recordings = useMemo(() => all.filter((r) => r.deviceId === device.id), [all, device.id]);

  const label = (n: number) => (n < 60 ? t('device.record.seconds', { n }) : t('device.record.minutes', { n: n / 60 }));

  const start = async () => {
    const began = Date.now();
    setStartedAt(began);
    const r = await run({ action: 'screen-record', params: { durationSec: duration }, failure: t('device.record.failed') });
    setStartedAt(null);
    if (!r.ok) return;
    const m = mediaResult(r.data);
    if (!m) {
      toast.error(t('device.record.failed'), { description: codeText('action.invalidResult') });
      return;
    }
    const rec = addRecording({ deviceId: device.id, url: m.url, file: m.file, ts: began, durationSec: duration });
    toast.success(t('device.record.done'), { action: { label: t('device.record.open'), onClick: () => window.open(rec.url, '_blank', 'noopener') } });
  };

  const left = startedAt !== null ? duration * 1000 - (now - startedAt) : 0;
  const progress = startedAt !== null ? Math.min(1, (now - startedAt) / (duration * 1000)) : 0;

  return (
    <DeviceCard section="record" title={t('device.record.title')} icon={Video} description={t('device.record.hint')}>
      <ActionErrorCallout error={error} onDismiss={clearError} />
      <div className="dv-row wrap">
        <span className="dv-label">{t('device.record.duration')}</span>
        <SegmentedControl<string>
          size="sm"
          value={String(duration)}
          onChange={(v) => setDuration(Number(v))}
          aria-label={t('device.record.duration')}
          options={durations.map((n) => ({ value: String(n), label: label(n), disabled: recording }))}
        />
        <span className="grow" />
        <Button variant="primary" size="sm" icon={Circle} loading={recording} onClick={() => void start()}>
          {t('device.record.start')}
        </Button>
      </div>
      {recording && startedAt !== null ? (
        <div className="dv-progress" role="status" aria-live="polite">
          <div className="dv-progress__bar" aria-hidden>
            <span className={left > 0 ? 'dv-progress__fill' : 'dv-progress__fill is-indeterminate'} style={left > 0 ? { width: `${progress * 100}%` } : undefined} />
          </div>
          <span className="dv-progress__text">{left > 0 ? t('device.record.recording', { left: mmss(left) }) : t('device.record.finishing')}</span>
        </div>
      ) : null}
      {recordings.length > 0 ? (
        <ul className="dv-recs" aria-label={t('device.record.list')}>
          {recordings.map((r) => (
            <li key={r.id} className="dv-rec">
              <video className="dv-rec__video" src={r.url} controls preload="metadata" />
              <div className="dv-rec__meta">
                <span className="tnum">{formatClock(r.ts, { ms: false })}</span>
                <span className="subtle">· {label(r.durationSec)}</span>
                <span className="grow" />
                <a className="btn btn--ghost btn--sm" href={r.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={14} aria-hidden />
                  <span className="btn__label">{t('device.record.open')}</span>
                </a>
                <Button size="sm" variant="ghost" icon={Download} onClick={() => downloadUrl(r.url, mediaFileName('recording', device, r.ts, r.file))}>
                  {t('device.record.download')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </DeviceCard>
  );
}
